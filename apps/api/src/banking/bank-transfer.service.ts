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
import { OtpService } from './otp.service';
import { formatMoney } from './money';

/**
 * Bank transfer (NIP) flow — send to any NGN bank account:
 *   resolve bank → name enquiry → confirm (with resolved name) → OTP → debit + payout → receipt.
 * The AI only prepares; only a verified OTP debits the ledger and calls the partner payout.
 * On a failed payout the debit is reversed; final status is reconciled by transfer.completed.
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
    private readonly otp: OtpService,
    private readonly partners: PartnerService,
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
        `Send ${formatMoney(cur, amount)} to:\n` +
        `*${accountName}*\n${bank.name} · ${accountNumber}\n\nConfirm?`,
      buttons: [
        { id: 'txn_confirm', title: 'Confirm ✅' },
        { id: 'txn_cancel', title: 'Cancel' },
      ],
    });
  }

  /** Step 2 — Confirm: issue an OTP and move to pending_otp. */
  async confirm(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'pending_otp');
    const code = await this.otp.issue(user.id, txn.id);
    await this.send(user, `🔐 Your GuildPay code is *${code}*.\nReply with it to send the transfer.`);
  }

  async cancel(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'cancelled');
    await this.send(user, 'Transfer cancelled. No money has moved.');
  }

  /** Step 3 — OTP verified: debit the ledger, then call the NIP payout. */
  async submitOtp(user: UserRow, wallet: WalletRow, code: string): Promise<void> {
    const result = await this.otp.verify(user.id, code);
    if (!result.ok) {
      await this.send(
        user,
        result.reason === 'too_many_attempts'
          ? 'Too many wrong attempts — the code is now void. Start the transfer again.'
          : result.reason === 'no_active_code'
            ? 'That code has expired. Please start the transfer again.'
            : 'That code is incorrect. Try again.',
      );
      return;
    }
    const txn = result.transactionId ? await this.txns.findById(result.transactionId) : null;
    if (!txn || txn.status !== 'pending_otp' || txn.type !== 'bank_transfer') {
      await this.send(user, 'That transfer is no longer pending.');
      return;
    }

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
        `${completed ? '✅ Sent' : '⏳ Processing'} ${formatMoney(cur, amount)} to *${txn.recipient_name}*.\n` +
          `Balance: ${formatMoney(cur, newBalance)}\nRef: ${txn.id.slice(0, 8)}`,
      );
    } catch (err) {
      // Reverse the debit — no money left the wallet.
      await this.wallet.credit(wallet.id, amount, txn.id);
      await this.txns.setStatus(txn.id, 'failed');
      this.logger.error(`bank transfer ${txn.id} payout failed: ${(err as Error).message}`);
      await this.send(user, 'The bank transfer failed — your money has been refunded.');
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
