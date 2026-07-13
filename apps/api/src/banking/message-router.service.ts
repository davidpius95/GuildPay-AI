import { Inject, Injectable } from '@nestjs/common';
import type { Currency, InboundMessage } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { AiService } from '../ai/ai.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository, type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletService } from './wallet.service';
import { OrchestratorService } from './orchestrator.service';
import { TransferService } from './transfer.service';
import { formatMoney } from './money';

/**
 * Router for onboarded users. State-machine first: a pending OTP or confirmation
 * is handled deterministically (no LLM). Only genuine free text hits the
 * orchestrator, which classifies intent and routes to a capability.
 */
@Injectable()
export class MessageRouter {
  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly ai: AiService,
    private readonly users: UsersRepository,
    private readonly wallets: WalletsRepository,
    private readonly txns: TransactionsRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
    private readonly orchestrator: OrchestratorService,
    private readonly transfer: TransferService,
  ) {}

  async handle(msg: InboundMessage): Promise<void> {
    const user = await this.users.findByWaPhone(msg.waPhone);
    if (!user) return;
    const wallet = (await this.wallets.findByUserId(user.id))[0];
    if (!wallet) return this.send(user, 'Your wallet is not set up yet. Send "hi" to finish onboarding.');

    const text = (msg.text ?? '').trim();
    const lower = text.toLowerCase();

    // ── deterministic: awaiting an OTP ──────────────────────────────────────
    const pendingOtp = await this.txns.findLatestByStatus(wallet.id, ['pending_otp']);
    if (pendingOtp) {
      if (lower === 'cancel') return this.transfer.cancel(user, pendingOtp);
      if (/^\d{4,8}$/.test(text)) return this.transfer.submitOtp(user, wallet, text);
      return this.send(user, 'Please reply with the code I sent, or type *CANCEL*.');
    }

    // ── deterministic: awaiting Confirm/Cancel ──────────────────────────────
    const pendingConf = await this.txns.findLatestByStatus(wallet.id, ['pending_confirmation']);
    if (pendingConf) {
      if (msg.interactiveReplyId === 'txn_confirm') return this.transfer.confirm(user, pendingConf);
      if (msg.interactiveReplyId === 'txn_cancel' || lower === 'cancel') {
        return this.transfer.cancel(user, pendingConf);
      }
      return this.send(user, 'Please tap *Confirm* or *Cancel* to continue.');
    }

    // ── global shortcuts ────────────────────────────────────────────────────
    if (lower === 'balance') return this.sendBalance(user, wallet);

    if (!text) {
      return this.send(user, "I can help with text for now — try *balance* or *send 2000 to 0803...*.");
    }

    // ── orchestrate free text ───────────────────────────────────────────────
    const intent = await this.orchestrator.parse(text);
    switch (intent.intent) {
      case 'balance':
        return this.sendBalance(user, wallet);
      case 'fund':
        if (intent.amount) return this.fund(user, wallet, intent.amount);
        return this.send(user, "How much would you like to add? e.g. *fund 5000*.");
      case 'p2p_transfer':
        if (intent.amount && intent.recipientRef) {
          return this.transfer.start(user, wallet, intent.amount, intent.recipientRef);
        }
        return this.send(
          user,
          !intent.amount
            ? 'How much would you like to send?'
            : 'Who should I send it to? Share their number or GuildPay reference.',
        );
      default:
        try {
          return this.send(user, await this.ai.chat(text));
        } catch {
          return this.send(user, "I'm here to help with your money — try *balance* or *send 2000 to 0803...*.");
        }
    }
  }

  private async sendBalance(user: UserRow, wallet: WalletRow): Promise<void> {
    const balance = await this.wallet.getBalance(wallet.id);
    await this.send(
      user,
      `💼 *Balance:* ${formatMoney(wallet.currency as Currency, balance)}\nWallet: ${wallet.reference}`,
    );
  }

  /** Demo funding — simulated credit, no OTP (money coming in). */
  private async fund(user: UserRow, wallet: WalletRow, amount: number): Promise<void> {
    const cur = wallet.currency as Currency;
    const txn = await this.txns.create({
      walletId: wallet.id,
      type: 'funding',
      channel: 'text',
      currency: cur,
      amount,
      status: 'completed',
    });
    const balance = await this.wallet.credit(wallet.id, amount, txn.id);
    await this.audit.record({
      userId: user.id,
      action: 'wallet_funded',
      entity: 'transaction',
      entityId: txn.id,
      metadata: { amount, demo: true },
    });
    await this.send(user, `✅ Added ${formatMoney(cur, amount)} (demo funds).\nNew balance: ${formatMoney(cur, balance)}`);
  }

  private async send(user: UserRow, body: string): Promise<void> {
    await this.channel.send({ to: user.wa_phone, kind: 'text', body });
  }
}
