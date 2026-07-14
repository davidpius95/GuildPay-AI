import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository, type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository, type TransactionRow } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletService, InsufficientFundsError } from './wallet.service';
import { OtpService } from './otp.service';
import { formatMoney, phoneCandidates } from './money';

/**
 * P2P transfer flow: prepare → confirm → OTP → ledger move → receipts.
 * The AI only prepares; only a verified OTP calls WalletService.transfer.
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
    private readonly otp: OtpService,
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

  /** Step 2 — user tapped Confirm: issue an OTP and move to pending_otp. */
  async confirm(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'pending_otp');
    const code = await this.otp.issue(user.id, txn.id);
    // DEMO: code delivered in-channel; production would use out-of-band SMS/auth.
    await this.send(user, `🔐 Your GuildPay code is *${code}*.\nReply with it to complete the transfer.`);
  }

  async cancel(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'cancelled');
    await this.send(user, 'Transfer cancelled. No money has moved.');
  }

  /** Step 3 — user replied with a code. Verify → move money → receipts. */
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
    if (!txn || txn.status !== 'pending_otp') {
      await this.send(user, 'That transfer is no longer pending.');
      return;
    }
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
