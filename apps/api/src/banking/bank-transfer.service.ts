import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository, type TransactionRow } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type { Bank } from '../partner/partner-adapter';
import { WalletService, InsufficientFundsError } from './wallet.service';
import { PinService } from './pin.service';
import { ReceiptService } from './receipt.service';
import { formatMoney } from './money';

const MAX_PIN_ATTEMPTS = 3;

/**
 * Bank transfer (NIP) flow — send to any NGN bank account:
 *   resolve bank → name enquiry → confirm (with resolved name) → PIN → debit + payout → receipt.
 * The AI only prepares; only a verified transaction PIN debits the ledger and calls
 * the partner payout. On a failed payout the debit is reversed; final status is
 * reconciled by transfer.completed.
 */
@Injectable()
export class BankTransferService {
  private readonly logger = new Logger(BankTransferService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly users: UsersRepository,
    private readonly txns: TransactionsRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
    private readonly pins: PinService,
    private readonly partners: PartnerService,
    private readonly receipts: ReceiptService,
  ) {}

  /** Step 1 — resolve bank + account name, then show the confirmation card. */
  async start(
    user: UserRow,
    wallet: WalletRow,
    amount: number,
    accountNumber: string,
    bankName: string,
  ): Promise<void> {
    const cur = wallet.currency as Currency;
    if (wallet.currency !== 'NGN') {
      return this.send(user, 'Bank transfers are available for NGN wallets only.');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      return this.send(user, 'Please give a valid 10-digit account number.');
    }
    if (amount > Number(wallet.txn_limit)) {
      return this.send(user, `That's above your per-transfer limit of ${formatMoney(cur, wallet.txn_limit)}.`);
    }
    if (amount > Number(wallet.balance)) {
      return this.send(user, `Insufficient balance. You have ${formatMoney(cur, wallet.balance)}.`);
    }

    const adapter = this.partners.forCurrency('NGN');
    let bank: Bank | null;
    try {
      bank = resolveBank(await adapter.listBanks(), bankName);
    } catch (err) {
      this.logger.error(`listBanks failed: ${(err as Error).message}`);
      return this.send(user, "I couldn't load the bank list just now. Please try again in a moment.");
    }
    if (!bank) {
      return this.send(user, `I couldn't identify the bank "${bankName}". Please send the exact bank name.`);
    }

    let accountName: string;
    try {
      accountName = (await adapter.nameEnquiry(accountNumber, bank.code)).accountName;
    } catch {
      return this.send(user, `I couldn't verify ${accountNumber} at ${bank.name}. Double-check the account number and bank.`);
    }

    await this.txns.create({
      walletId: wallet.id,
      type: 'bank_transfer',
      channel: 'text',
      currency: cur,
      amount,
      recipientName: accountName,
      recipientRef: accountNumber,
      bankCode: bank.code,
      status: 'pending_confirmation',
    });
    await this.channel.send({
      to: user.wa_phone,
      kind: 'interactive',
      body:
        `Please confirm this transfer:\n\n` +
        `Amount: *${formatMoney(cur, amount)}*\n` +
        `To: ⚠️ *${accountName}*\n` +
        `Bank: ${bank.name}\n` +
        `Account: ${accountNumber}`,
      buttons: [
        { id: 'txn_confirm', title: 'Confirm ✅' },
        { id: 'txn_cancel', title: 'Cancel' },
      ],
    });
  }

  /** Step 2 — Confirm: ask for the transaction PIN. */
  async confirm(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'pending_otp'); // status name kept for schema compat; gate is the PIN
    await this.send(
      user,
      user.pin_hash
        ? '🔐 Enter your *4-digit transaction PIN* to send the transfer, or type *CANCEL*.'
        : "🔐 You don't have a transaction PIN yet.\nReply with a *new 4-digit PIN* to set it — then I'll ask you to enter it to approve this transfer.",
    );
  }

  async cancel(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'cancelled');
    await this.send(user, 'Transfer cancelled. No money has moved.');
  }

  /** Step 3 — PIN verified: debit the ledger, then call the NIP payout. */
  async submitPin(user: UserRow, wallet: WalletRow, pin: string): Promise<void> {
    const txn = await this.txns.findLatestByStatus(wallet.id, ['pending_otp']);
    if (!txn || txn.type !== 'bank_transfer') {
      await this.send(user, 'That transfer is no longer pending.');
      return;
    }
    if (!(await this.pinGate(user, txn, pin))) return;

    const cur = wallet.currency as Currency;
    const amount = Number(txn.amount);

    // Debit first (holds the funds); reverse on payout failure.
    try {
      await this.wallet.debit(wallet.id, amount, txn.id);
    } catch (err) {
      await this.txns.setStatus(txn.id, 'failed');
      await this.send(
        user,
        err instanceof InsufficientFundsError
          ? 'Insufficient balance — the transfer was not completed.'
          : 'The transfer failed and no money moved.',
      );
      return;
    }

    try {
      const res = await this.partners.forCurrency('NGN').bankTransfer({
        transactionId: txn.id,
        fromAccountRef: wallet.reference,
        accountNumber: txn.recipient_ref!,
        bankCode: txn.bank_code!,
        recipientName: txn.recipient_name ?? '',
        amount,
        narration: 'GuildPay transfer',
      });
      if (res.status === 'failed') throw new Error('payout rejected');

      const completed = res.status === 'completed';
      await this.txns.setStatus(txn.id, completed ? 'completed' : 'pending');
      await this.audit.record({
        userId: user.id,
        action: 'bank_transfer_initiated',
        entity: 'transaction',
        entityId: txn.id,
        metadata: { amount, bankCode: txn.bank_code },
      });
      const newBalance = await this.wallet.getBalance(wallet.id);
      await this.send(
        user,
        `${completed ? '✅ *Transfer successful*' : '⏳ *Transfer processing*'}\n\n` +
          `Amount: ${formatMoney(cur, amount)}\n` +
          `To: ${txn.recipient_name}\n` +
          `Account: ${txn.recipient_ref}\n` +
          `Ref: ${txn.id.slice(0, 8).toUpperCase()}\n\n` +
          `Your new balance is *${formatMoney(cur, newBalance)}*.`,
      );
      await this.sendReceipt(user, wallet, txn, amount, completed);
      await this.channel.send({
        to: user.wa_phone,
        kind: 'interactive',
        body: `Save *${txn.recipient_name}* as a beneficiary?`,
        buttons: [
          { id: 'bene_save', title: 'Save ✅' },
          { id: 'bene_no', title: 'No thanks' },
        ],
      });
    } catch (err) {
      // Reverse the debit — no money left the wallet.
      await this.wallet.credit(wallet.id, amount, txn.id);
      await this.txns.setStatus(txn.id, 'failed');
      this.logger.error(`bank transfer ${txn.id} payout failed: ${(err as Error).message}`);
      await this.send(user, 'The bank transfer failed — your money has been refunded.');
    }
  }

  /**
   * The PIN gate — the ONLY path to money movement. First-time users set their
   * PIN here (hashed; raw PIN never stored/logged), then must enter it again.
   * 3 wrong attempts cancel the transaction.
   */
  private async pinGate(user: UserRow, txn: TransactionRow, pin: string): Promise<boolean> {
    if (!this.pins.isValidFormat(pin)) {
      await this.send(user, 'Your PIN is *4 digits*. Try again, or type *CANCEL*.');
      return false;
    }
    if (!user.pin_hash) {
      await this.users.update(user.id, { pin_hash: this.pins.hash(pin) });
      await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
      await this.send(user, '✅ PIN saved.\n\n🔐 Now enter your PIN to approve the transfer.');
      return false; // must enter it again — setting a PIN never approves money
    }
    if (!this.pins.verify(pin, user.pin_hash)) {
      await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_failed', entity: 'transaction', entityId: txn.id });
      const fails = await this.audit.countByEntityAction(txn.id, 'pin_failed');
      if (fails >= MAX_PIN_ATTEMPTS) {
        await this.txns.setStatus(txn.id, 'cancelled');
        await this.send(user, '❌ Too many wrong attempts — the transfer was cancelled. No money moved.');
      } else {
        await this.send(user, `Incorrect PIN (${fails}/${MAX_PIN_ATTEMPTS}). Try again, or type *CANCEL*.`);
      }
      return false;
    }
    return true;
  }

  /** Render + send the GuildPay-branded receipt image. Best-effort (never blocks the flow). */
  private async sendReceipt(
    user: UserRow,
    wallet: WalletRow,
    txn: TransactionRow,
    amount: number,
    completed: boolean,
  ): Promise<void> {
    try {
      let bankName: string | undefined;
      if (txn.bank_code) {
        try {
          const banks = await this.partners.forCurrency('NGN').listBanks();
          bankName = banks.find((b) => b.code === txn.bank_code)?.name;
        } catch {
          /* bank name is optional on the receipt */
        }
      }
      const png = this.receipts.render({
        status: completed ? 'COMPLETED' : 'PROCESSING',
        currency: wallet.currency as Currency,
        amount,
        sender: user.full_name ?? 'GuildPay user',
        recipient: txn.recipient_name ?? txn.recipient_ref ?? '—',
        bank: bankName,
        account: txn.recipient_ref ?? undefined,
        reference: txn.id.slice(0, 8).toUpperCase(),
      });
      await this.channel.send({
        to: user.wa_phone,
        kind: 'image',
        image: png,
        caption: `${completed ? 'Transfer complete' : 'Transfer processing'} — ${formatMoney(wallet.currency as Currency, amount)}`,
      });
    } catch (err) {
      this.logger.warn(`receipt render/send failed: ${(err as Error).message}`);
    }
  }

  private async send(user: UserRow, body: string): Promise<void> {
    await this.channel.send({ to: user.wa_phone, kind: 'text', body });
  }
}

/** Resolve a free-text bank name to a single Bank, or null if none/ambiguous. */
export function resolveBank(banks: Bank[], query: string): Bank | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = banks.filter((b) => b.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0]!;
  const partial = banks.filter((b) => {
    const n = b.name.toLowerCase();
    return n.includes(q) || q.includes(n);
  });
  return partial.length === 1 ? partial[0]! : null;
}
