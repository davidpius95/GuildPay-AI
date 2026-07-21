import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { FlutterwavePartnerAdapter } from '../partner/flutterwave-partner.adapter';
import { WalletsRepository } from '../database/wallets.repository';
import { TransactionsRepository } from '../database/transactions.repository';
import { UsersRepository } from '../database/users.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletService } from '../banking/wallet.service';
import { WalletFundingService } from '../banking/wallet-funding.service';
import { ReceiptService } from '../banking/receipt.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { TransactionRow } from '../database/transactions.repository';
import { formatMoney } from '../banking/money';

/** Fields we read from a Flutterwave webhook envelope. */
interface FlwWebhook {
  event?: string;
  'event.type'?: string;
  data?: {
    id?: number | string;
    status?: string;
    tx_ref?: string;
    flw_ref?: string;
    reference?: string;
    amount?: number;
    currency?: string;
  };
}

/**
 * Flutterwave webhook. Verifies `verif-hash` against FLW_WEBHOOK_SECRET_HASH, then:
 *   - charge.completed  → inbound funding of a user's NUBAN: re-verify server-side,
 *                         match wallet by tx_ref (== wallet reference set at account
 *                         creation), credit the ledger (idempotent), notify the user.
 *   - transfer.completed / bvn.verification.completed → logged for reconciliation.
 *
 * Acks Meta/Flutterwave immediately (200) and processes in the background so a slow
 * verify call never triggers webhook retries. Duplicate deliveries are deduped on flw_ref.
 */
@Controller('webhooks/flutterwave')
export class FlutterwaveController {
  private readonly logger = new Logger(FlutterwaveController.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly flw: FlutterwavePartnerAdapter,
    private readonly wallets: WalletsRepository,
    private readonly txns: TransactionsRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
    private readonly funding: WalletFundingService,
    private readonly receipts: ReceiptService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Post()
  @HttpCode(200)
  receive(@Headers('verif-hash') hash: string | undefined, @Body() body: FlwWebhook): { status: string } {
    const expected = this.config.get<string>('FLW_WEBHOOK_SECRET_HASH');
    if (!expected || !hash || !constantTimeEqual(hash, expected)) {
      throw new ForbiddenException('invalid verif-hash');
    }
    void this.process(body);
    return { status: 'ok' };
  }

  private async process(body: FlwWebhook): Promise<void> {
    const event = body?.event ?? body?.['event.type'] ?? 'unknown';
    try {
      switch (event) {
        case 'charge.completed':
          await this.handleChargeCompleted(body.data ?? {});
          break;
        case 'transfer.completed':
          await this.handleTransferCompleted(body.data ?? {});
          break;
        case 'bvn.verification.completed':
          await this.handleBvnVerificationCompleted(body.data ?? {});
          break;
        default:
          // Chargeback/dispute notifications: FLW uses a few event names — record
          // them for the admin Disputes view and reconciliation (no user money moves).
          if (event.includes('dispute') || event.includes('chargeback')) {
            await this.handleDisputeEvent(event, body.data ?? {});
            break;
          }
          this.logger.log(`unhandled Flutterwave event: ${event}`);
      }
    } catch (err) {
      this.logger.error(`Flutterwave ${event} processing failed: ${(err as Error).message}`);
    }
  }

  /** Credit a user's wallet when money lands in their NUBAN. Safe-by-construction. */
  private async handleChargeCompleted(data: NonNullable<FlwWebhook['data']>): Promise<void> {
    if (data.id === undefined) return;
    const flwRef = data.flw_ref ?? String(data.id);

    // Idempotency: Flutterwave retries and can double-deliver.
    if (await this.txns.findByProviderRef(flwRef)) {
      this.logger.log(`charge.completed duplicate ignored (flw_ref=${flwRef})`);
      return;
    }

    // Never trust the webhook body's amount/status — re-verify at source.
    let verified: { status: string; amount: number; currency: string; txRef: string };
    try {
      verified = await this.flw.verifyTransaction(data.id);
    } catch (err) {
      this.logger.error(`verifyTransaction(${data.id}) failed: ${(err as Error).message}`);
      return;
    }
    if (verified.status?.toLowerCase() !== 'successful') {
      this.logger.log(`charge ${data.id} not successful (status=${verified.status}) — skipped`);
      return;
    }

    // Match to a wallet: tx_ref echoes the reference we set at account creation.
    const ref = (verified.txRef ?? data.tx_ref ?? '').trim();
    const wallet = ref ? await this.wallets.findByReference(ref.toUpperCase()) : null;
    if (!wallet) {
      this.logger.warn(`funding unmatched: tx_ref=${ref || '—'} amount=${verified.amount} — manual reconcile`);
      await this.audit.record({ action: 'funding_unmatched', entity: 'transaction', metadata: { txRef: ref, flwRef } });
      return;
    }
    if (verified.currency !== wallet.currency) {
      this.logger.warn(`funding currency mismatch wallet=${wallet.currency} charge=${verified.currency}`);
      return;
    }

    await this.funding.creditInbound({
      wallet,
      amount: Number(verified.amount),
      currency: wallet.currency as Currency,
      providerRef: flwRef,
      source: 'bank_transfer',
    });
  }

  /**
   * A user's BVN consent verification finished. Never trust the webhook body's
   * status — re-read the authoritative result from Flutterwave by reference, then
   * let onboarding provision the NUBAN (on success) or re-prompt (on failure).
   */
  private async handleBvnVerificationCompleted(data: NonNullable<FlwWebhook['data']>): Promise<void> {
    const reference = (data.reference ?? (data.id != null ? String(data.id) : '')).trim();
    if (!reference) {
      this.logger.warn('bvn.verification.completed with no reference — ignored');
      return;
    }
    let result;
    try {
      result = await this.flw.fetchBvnVerification(reference);
    } catch (err) {
      // If we can't confirm at source, don't guess — leave the user in kyc_pending
      // so a retry / redelivery can still complete them.
      this.logger.error(`fetchBvnVerification(${reference}) failed: ${(err as Error).message}`);
      return;
    }
    await this.onboarding.completeBvnConsent(reference, result);
  }

  /** Reconcile a NIP payout: confirm on success, reverse the debit on failure (idempotent). */
  private async handleTransferCompleted(data: NonNullable<FlwWebhook['data']>): Promise<void> {
    const ref = (data.reference ?? '').trim(); // we sent reference = our transaction id
    if (!ref) return;
    const txn = await this.txns.findById(ref);
    if (!txn || txn.type !== 'bank_transfer') {
      this.logger.log(`transfer.completed ref=${ref} — no matching bank_transfer txn`);
      return;
    }
    const status = (data.status ?? '').toUpperCase();
    if (status === 'SUCCESSFUL') {
      // Only notify once (webhooks retry): act just as it transitions to completed.
      if (txn.status !== 'completed') {
        await this.txns.setStatus(txn.id, 'completed');
        const providerId = data.id != null ? String(data.id) : undefined;
        await this.notifyTransferSuccess(txn, providerId, data.flw_ref ?? undefined);
      }
      this.logger.log(`transfer ${txn.id} confirmed successful`);
      return;
    }
    if (status !== 'FAILED') return;
    if (txn.status === 'failed') return; // already reversed

    const amount = Number(txn.amount);
    const flwRef = data.id ? String(data.id) : ref;
    await this.wallet.credit(txn.wallet_id, amount, txn.id, 'Transfer Refund from Flutterwave', flwRef); // refund the earlier debit
    await this.txns.setStatus(txn.id, 'failed');
    await this.audit.record({
      action: 'bank_transfer_reversed',
      entity: 'transaction',
      entityId: txn.id,
      metadata: { amount },
    });
    const wallet = await this.wallets.findById(txn.wallet_id);
    const user = wallet ? await this.users.findById(wallet.user_id) : null;
    if (wallet && user) {
      await this.channel.send({
        to: user.wa_phone,
        kind: 'text',
        body: `↩️ Your transfer of ${formatMoney(wallet.currency as Currency, amount)} to ${txn.recipient_name} failed and was refunded.`,
      });
    }
    this.logger.log(`transfer ${txn.id} failed — reversed ${amount}`);
  }

  /**
   * A NIP payout is asynchronous — the user first sees "processing". When the
   * transfer.completed webhook confirms success, upgrade them to a clear
   * "successful" message and a COMPLETED receipt (so they never stay on
   * "processing"). Best-effort; the money has already moved.
   */
  private async notifyTransferSuccess(
    txn: TransactionRow,
    providerId?: string,
    providerRef?: string,
  ): Promise<void> {
    try {
      const wallet = await this.wallets.findById(txn.wallet_id);
      const user = wallet ? await this.users.findById(wallet.user_id) : null;
      if (!wallet || !user) return;
      const cur = wallet.currency as Currency;
      const amount = Number(txn.amount);

      await this.channel.send({
        to: user.wa_phone,
        kind: 'text',
        body:
          `✅ *Transfer successful*\n\n` +
          `Amount: ${formatMoney(cur, amount)}\n` +
          `To: ${txn.recipient_name}\n` +
          `Account: ${txn.recipient_ref}\n` +
          `Ref: ${providerRef ?? txn.id.slice(0, 8).toUpperCase()}`,
      });

      let bankName: string | undefined;
      if (txn.bank_code) {
        try {
          const banks = await this.flw.listBanks();
          bankName = banks.find((b) => b.code === txn.bank_code)?.name;
        } catch {
          /* bank name is optional on the receipt */
        }
      }
      const png = this.receipts.render({
        status: 'COMPLETED',
        currency: cur,
        amount,
        sender: user.full_name ?? 'GuildPay user',
        recipient: txn.recipient_name ?? txn.recipient_ref ?? '—',
        bank: bankName,
        account: txn.recipient_ref ?? undefined,
        reference: txn.id.slice(0, 8).toUpperCase(),
        providerRef,
        providerId,
      });
      await this.channel.send({
        to: user.wa_phone,
        kind: 'image',
        image: png,
        caption: `Transfer complete — ${formatMoney(cur, amount)}`,
      });
    } catch (err) {
      this.logger.warn(`transfer success notify failed for ${txn.id}: ${(err as Error).message}`);
    }
  }

  /** Record a chargeback/dispute event for the admin Disputes view + reconciliation. */
  private async handleDisputeEvent(event: string, data: NonNullable<FlwWebhook['data']>): Promise<void> {
    const disputeId = data.id !== undefined ? String(data.id) : null;
    await this.audit.record({
      action: 'dispute_event',
      entity: 'transaction',
      entityId: disputeId ?? undefined,
      metadata: { event, disputeId, status: data.status ?? null, txRef: data.tx_ref ?? null },
    });
    this.logger.warn(`dispute event: ${event} id=${disputeId ?? '—'} status=${data.status ?? '—'}`);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
