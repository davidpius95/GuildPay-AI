import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { WhatsappFlowService } from '../channel/whatsapp-flow.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository, type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository, type TransactionRow } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletService, InsufficientFundsError } from './wallet.service';
import { PinService } from './pin.service';
import { ReceiptService } from './receipt.service';
import { formatMoney, phoneCandidates } from './money';

const MAX_PIN_ATTEMPTS = 3;

/**
 * P2P transfer flow: prepare → confirm → PIN → ledger move → receipts.
 * The AI only prepares; only a verified transaction PIN calls
 * WalletService.transfer (the no-pin-no-money gate).
 */
@Injectable()
export class TransferService {
  private readonly logger = new Logger(TransferService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly users: UsersRepository,
    private readonly wallets: WalletsRepository,
    private readonly txns: TransactionsRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
    private readonly pins: PinService,
    private readonly receipts: ReceiptService,
    private readonly flows: WhatsappFlowService,
  ) {}

  /** Step 1 — validate, create a pending_confirmation transaction, show the card. */
  async start(user: UserRow, wallet: WalletRow, amount: number, recipientRef: string): Promise<void> {
    const cur = wallet.currency as Currency;
    const recipient = await this.resolveRecipient(recipientRef, wallet);
    if (!recipient) {
      return this.send(user, `I couldn't find a GuildPay account for "${recipientRef}". Double-check the number or GuildPay reference.`);
    }
    if (recipient.id === wallet.id) {
      return this.send(user, "You can't send money to yourself. 🙂");
    }
    if (recipient.currency !== wallet.currency) {
      return this.send(user, `That recipient uses ${recipient.currency}, but your wallet is ${wallet.currency}. Cross-currency transfers aren't supported yet.`);
    }
    if (amount > Number(wallet.txn_limit)) {
      return this.send(user, `That's above your per-transfer limit of ${formatMoney(cur, wallet.txn_limit)}.`);
    }
    if (amount > Number(wallet.balance)) {
      return this.send(user, `Insufficient balance. You have ${formatMoney(cur, wallet.balance)}.`);
    }

    const recipientUser = await this.userOf(recipient);
    const recipientName = recipientUser?.full_name ?? recipient.reference;
    await this.txns.create({
      walletId: wallet.id,
      type: 'p2p_transfer',
      channel: 'text',
      currency: cur,
      amount,
      recipientName,
      recipientRef: recipient.reference,
      status: 'pending_confirmation',
    });
    await this.channel.send({
      to: user.wa_phone,
      kind: 'interactive',
      body: `Send ${formatMoney(cur, amount)} to *${recipientName}*?`,
      buttons: [
        { id: 'txn_confirm', title: 'Confirm ✅' },
        { id: 'txn_cancel', title: 'Cancel' },
      ],
    });
  }

  /** Step 2 — Confirm: ask for the transaction PIN (via secure Flow when available). */
  async confirm(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'pending_otp'); // status name kept for schema compat; gate is the PIN
    // The WhatsApp Flow modal keeps the PIN secure so it never lands in chat.
    // First-time PIN set and non-Meta channels fall back to the chat prompt.
    if (this.channel.name === 'meta' && this.flows.isEnabled()) {
      const cur = txn.currency as Currency;
      const isSetup = !user.pin_hash;
      await this.channel.send(
        this.flows.buildPinFlowMessage(
          user.wa_phone,
          txn.id,
          isSetup
            ? `🔐 You don't have a transaction PIN yet.\nTap *Set PIN* to securely set your 4-digit PIN.`
            : `🔐 Approve your transfer of *${formatMoney(cur, txn.amount)}* to ${txn.recipient_name}.\nTap *Verify Transaction* to enter your PIN securely.`,
          isSetup ? 'Set PIN' : 'Verify Transaction',
        ),
      );
      return;
    }
    await this.send(
      user,
      user.pin_hash
        ? '🔐 Enter your *4-digit transaction PIN* to complete the transfer, or type *CANCEL*.'
        : "🔐 You don't have a transaction PIN yet.\nReply with a *new 4-digit PIN* to set it — then I'll ask you to enter it to approve this transfer.",
    );
  }

  async cancel(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'cancelled');
    await this.send(user, 'Transfer cancelled. No money has moved.');
  }

  /** Step 3 — user replied with their PIN. Verify → move money → receipts. */
  async submitPin(user: UserRow, wallet: WalletRow, pin: string): Promise<void> {
    const txn = await this.txns.findLatestByStatus(wallet.id, ['pending_otp']);
    if (!txn || txn.type !== 'p2p_transfer') {
      await this.send(user, 'That transfer is no longer pending.');
      return;
    }
    if (!(await this.pinGate(user, txn, pin))) return;

    const recipient = txn.recipient_ref ? await this.wallets.findByReference(txn.recipient_ref) : null;
    if (!recipient) {
      await this.txns.setStatus(txn.id, 'failed');
      await this.send(user, 'Something went wrong finding the recipient. No money moved.');
      return;
    }

    const cur = wallet.currency as Currency;
    const amount = Number(txn.amount);
    try {
      const { fromBalance, toBalance } = await this.wallet.transfer(
        wallet.id,
        recipient.id,
        amount,
        txn.id,
        'GuildPay P2P Transfer',
        txn.id
      );
      await this.txns.setStatus(txn.id, 'completed');
      await this.audit.record({
        userId: user.id,
        action: 'transfer_completed',
        entity: 'transaction',
        entityId: txn.id,
        metadata: { amount, to: recipient.reference },
      });
      await this.send(
        user,
        `✅ Sent ${formatMoney(cur, amount)} to *${txn.recipient_name}*.\nNew balance: ${formatMoney(cur, fromBalance)}\nRef: ${txn.id.slice(0, 8)}`,
      );
      try {
        const png = this.receipts.render({
          status: 'COMPLETED',
          currency: cur,
          amount,
          sender: user.full_name ?? 'GuildPay user',
          recipient: txn.recipient_name ?? recipient.reference,
          account: recipient.reference,
          reference: txn.id.slice(0, 8).toUpperCase(),
          date: new Date(txn.created_at),
        });
        await this.channel.send({
          to: user.wa_phone,
          kind: 'image',
          image: png,
          caption: `Transfer complete — ${formatMoney(cur, amount)}`,
        });
      } catch (err) {
        this.logger.warn(`receipt render/send failed: ${(err as Error).message}`);
      }
      const recipientUser = await this.userOf(recipient);
      if (recipientUser) {
        await this.channel.send({
          to: recipientUser.wa_phone,
          kind: 'text',
          body: `💰 You received ${formatMoney(cur, amount)} from *${user.full_name ?? 'a GuildPay user'}*.\nNew balance: ${formatMoney(cur, toBalance)}`,
        });
      }
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
      await this.txns.setStatus(txn.id, 'failed');
      this.logger.error(`transfer ${txn.id} failed: ${(err as Error).message}`);
      await this.send(
        user,
        err instanceof InsufficientFundsError
          ? 'Insufficient balance — the transfer was not completed.'
          : 'The transfer failed and no money moved.',
      );
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
      const pinHash = this.pins.hash(pin);
      await this.users.update(user.id, { pin_hash: pinHash });
      await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
      await this.send(user, '✅ PIN saved.');
      await this.confirm({ ...user, pin_hash: pinHash }, txn);
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

  private async resolveRecipient(ref: string, sender: WalletRow): Promise<WalletRow | null> {
    if (/^GPA-/i.test(ref.trim())) {
      return this.wallets.findByReference(ref.trim().toUpperCase());
    }
    const user = await this.users.findByAnyWaPhone(phoneCandidates(ref, sender.market));
    if (!user) return null;
    const wallets = await this.wallets.findByUserId(user.id);
    return wallets.find((w) => w.currency === sender.currency) ?? null;
  }

  private async userOf(wallet: WalletRow): Promise<UserRow | null> {
    return this.users.findById(wallet.user_id);
  }

  private async send(user: UserRow, body: string): Promise<void> {
    await this.channel.send({ to: user.wa_phone, kind: 'text', body });
  }
}
