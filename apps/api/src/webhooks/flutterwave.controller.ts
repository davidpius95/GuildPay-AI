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
          // TODO(M3b): reconcile payout by reference; on FAILED, Flutterwave auto-reverses.
          this.logger.log(`transfer.completed ref=${body.data?.tx_ref ?? '—'} status=${body.data?.status}`);
          break;
        case 'bvn.verification.completed':
          this.logger.log(`bvn.verification.completed status=${body.data?.status}`);
          break;
        default:
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

    const currency = wallet.currency as Currency;
    const amount = Number(verified.amount);
    const txn = await this.txns.create({
      walletId: wallet.id,
      type: 'funding',
      channel: 'bank_transfer',
      currency,
      amount,
      providerRef: flwRef,
      status: 'completed',
    });
    const balance = await this.wallet.credit(wallet.id, amount, txn.id);
    await this.audit.record({
      userId: wallet.user_id,
      action: 'wallet_funded',
      entity: 'transaction',
      entityId: txn.id,
      metadata: { amount, source: 'bank_transfer' },
    });

    const user = await this.users.findById(wallet.user_id);
    if (user) {
      await this.channel.send({
        to: user.wa_phone,
        kind: 'text',
        body: `💰 Received ${formatMoney(currency, amount)}.\nNew balance: ${formatMoney(currency, balance)}`,
      });
    }
    this.logger.log(`wallet ${wallet.reference} funded ${amount} ${currency} (flw_ref=${flwRef})`);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
