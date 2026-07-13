import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, ForbiddenException, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Minimal shape of a Flutterwave webhook envelope (fields we route on). */
interface FlwWebhook {
  event?: string;
  'event.type'?: string;
  data?: { id?: number | string; status?: string; tx_ref?: string; reference?: string };
}

/**
 * Flutterwave webhook. Verifies the `verif-hash` header against the secret hash
 * configured in the Flutterwave dashboard (FLW_WEBHOOK_SECRET_HASH), then routes
 * the three live events GuildPay cares about:
 *   - charge.completed            → inbound funding of a user's NUBAN
 *   - transfer.completed          → outbound NIP payout result (+ auto-reversal on fail)
 *   - bvn.verification.completed  → consent-based BVN result (Option A onboarding)
 *
 * Crediting/debiting the ledger for these events lands with WalletService (M2);
 * the handlers verify + log so the endpoint is real, secure, and testable now.
 */
@Controller('webhooks/flutterwave')
export class FlutterwaveController {
  private readonly logger = new Logger(FlutterwaveController.name);

  constructor(private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Headers('verif-hash') hash: string | undefined,
    @Body() body: FlwWebhook,
  ): { status: string } {
    const expected = this.config.get<string>('FLW_WEBHOOK_SECRET_HASH');
    if (!expected || !hash || !constantTimeEqual(hash, expected)) {
      throw new ForbiddenException('invalid verif-hash');
    }

    const event = body?.event ?? body?.['event.type'] ?? 'unknown';
    const ref = body?.data?.id ?? body?.data?.tx_ref ?? body?.data?.reference ?? '—';

    switch (event) {
      case 'charge.completed':
        // TODO(M2): PartnerService.forCurrency('NGN').verifyTransaction(data.id),
        // confirm amount+currency+status='successful', then WalletService.credit().
        this.logger.log(`charge.completed ref=${ref} status=${body?.data?.status}`);
        break;
      case 'transfer.completed':
        // TODO(M2): reconcile payout by reference; on FAILED, Flutterwave auto-reverses.
        this.logger.log(`transfer.completed ref=${ref} status=${body?.data?.status}`);
        break;
      case 'bvn.verification.completed':
        // TODO: cross-check returned phone == user's WhatsApp number, then advance KYC.
        this.logger.log(`bvn.verification.completed ref=${ref} status=${body?.data?.status}`);
        break;
      default:
        this.logger.log(`unhandled Flutterwave event: ${event}`);
    }

    return { status: 'ok' };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
