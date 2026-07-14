import { Inject, Injectable } from '@nestjs/common';
import type { Currency, InboundMessage } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { AiService } from '../ai/ai.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository, type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { BeneficiariesRepository } from '../database/beneficiaries.repository';
import { WalletService } from './wallet.service';
import { OrchestratorService } from './orchestrator.service';
import { TransferService } from './transfer.service';
import { BankTransferService } from './bank-transfer.service';
import { SnapToPayService } from './snap-to-pay.service';
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
    private readonly beneficiaries: BeneficiariesRepository,
    private readonly wallet: WalletService,
    private readonly orchestrator: OrchestratorService,
    private readonly transfer: TransferService,
    private readonly bankTransfer: BankTransferService,
    private readonly snapToPay: SnapToPayService,
  ) {}

  /** Snap-to-pay: an onboarded user sent a photo. Vision prefills a bank transfer. */
  async handleImage(msg: InboundMessage, image: Buffer, mimeType: string): Promise<void> {
    const user = await this.users.findByWaPhone(msg.waPhone);
    if (!user) return;
    const wallet = (await this.wallets.findByUserId(user.id))[0];
    if (!wallet) return this.send(user, 'Your wallet is not set up yet. Send "hi" to finish onboarding.');
    await this.snapToPay.fromImage(user, wallet, image, mimeType);
  }

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
      const svc = pendingOtp.type === 'bank_transfer' ? this.bankTransfer : this.transfer;
      if (lower === 'cancel') return svc.cancel(user, pendingOtp);
      if (/^\d{4,8}$/.test(text)) return svc.submitOtp(user, wallet, text);
      return this.send(user, 'Please reply with the code I sent, or type *CANCEL*.');
    }

    // ── deterministic: awaiting Confirm/Cancel ──────────────────────────────
    const pendingConf = await this.txns.findLatestByStatus(wallet.id, ['pending_confirmation']);
    if (pendingConf) {
      const svc = pendingConf.type === 'bank_transfer' ? this.bankTransfer : this.transfer;
      if (msg.interactiveReplyId === 'txn_confirm') return svc.confirm(user, pendingConf);
      if (msg.interactiveReplyId === 'txn_cancel' || lower === 'cancel') {
        return svc.cancel(user, pendingConf);
      }
      return this.send(user, 'Please tap *Confirm* or *Cancel* to continue.');
    }

    // ── interactive quick-action / beneficiary buttons (no pending txn) ──────
    if (msg.interactiveReplyId) return this.handleButton(user, wallet, msg.interactiveReplyId);

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
        return this.handleFundIntent(user, wallet, intent.amount);
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
      case 'bank_transfer':
        if (intent.amount && intent.accountNumber && intent.bankName) {
          return this.bankTransfer.start(user, wallet, intent.amount, intent.accountNumber, intent.bankName);
        }
        return this.send(
          user,
          !intent.amount
            ? 'How much would you like to send?'
            : !intent.accountNumber
              ? "What's the account number?"
              : 'Which bank is that account with?',
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
    await this.channel.send({
      to: user.wa_phone,
      kind: 'interactive',
      body:
        `💼 Your balance is *${formatMoney(wallet.currency as Currency, balance)}*.\n` +
        `Wallet: ${wallet.reference}\n\nWhat would you like to do?`,
      buttons: [
        { id: 'act_fund', title: 'Fund wallet' },
        { id: 'act_send', title: 'Send money' },
      ],
    });
  }

  /** Route a tapped quick-action / beneficiary button (used when no txn is pending). */
  private async handleButton(user: UserRow, wallet: WalletRow, id: string): Promise<void> {
    switch (id) {
      case 'act_balance':
        return this.sendBalance(user, wallet);
      case 'act_fund':
        return this.handleFundIntent(user, wallet);
      case 'act_send':
        return this.send(
          user,
          'Who should I send to?\n' +
            '• GuildPay user: *send 2000 to 0803...*\n' +
            '• Any bank: *send 5000 to 0690000031 GTBank*',
        );
      case 'bene_save':
        return this.saveBeneficiary(user, wallet);
      case 'bene_no':
        return this.send(user, 'No problem 👍');
      default:
        return this.send(user, 'Tap an option above, or just tell me what you need. 💬');
    }
  }

  /** Save the most recent completed transfer's recipient as a beneficiary. */
  private async saveBeneficiary(user: UserRow, wallet: WalletRow): Promise<void> {
    const txn = await this.txns.findLatestByStatus(wallet.id, ['completed']);
    if (!txn || !txn.recipient_ref) {
      return this.send(user, "I couldn't find a recent recipient to save.");
    }
    await this.beneficiaries.add({
      userId: user.id,
      name: txn.recipient_name ?? txn.recipient_ref,
      ref: txn.recipient_ref,
      bankCode: txn.bank_code,
      currency: wallet.currency as Currency,
    });
    await this.send(user, `✅ Saved *${txn.recipient_name ?? txn.recipient_ref}* as a beneficiary.`);
  }

  /** Route funding requests to real NUBAN accounts (NGN) or demo credits (QAR). */
  private async handleFundIntent(user: UserRow, wallet: WalletRow, amount?: number | null): Promise<void> {
    if (wallet.currency === 'NGN') {
      if (!wallet.virtual_account_number) {
        return this.send(user, 'Your account is still being set up. Please try again in a few minutes.');
      }
      return this.send(
        user,
        `*Fund your wallet* — transfer to:\n` +
          `Bank: ${wallet.virtual_bank_name}\n` +
          `Account: ${wallet.virtual_account_number}\n` +
          `Name: ${user.full_name ?? 'GuildPay user'}`
      );
    }
    
    // Demo funding for simulated currencies (QAR)
    if (amount) {
      return this.fund(user, wallet, amount);
    }
    return this.send(user, 'How much would you like to add? e.g. *fund 5000*.');
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
