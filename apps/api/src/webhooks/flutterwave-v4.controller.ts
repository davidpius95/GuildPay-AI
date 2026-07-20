import { createHmac, timingSafeEqual } from 'node:crypto';
import { Body, Controller, ForbiddenException, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import type { Currency } from '@guildpay/shared';
import { WalletsRepository } from '../database/wallets.repository';
import { AuditRepository } from '../database/audit.repository';
import { WalletFundingService } from '../banking/wallet-funding.service';

/**
 * Flutterwave v4 webhook — funding for virtual accounts created via the v4 Wallets
 * API. Kept separate from the v3 controller because v4 authenticates webhooks with
 * an HMAC-SHA256 `flutterwave-signature` header over the raw body (vs v3's static
 * `verif-hash`). On a virtual-account credit it matches the wallet by account
 * number and credits it via the shared, idempotent WalletFundingService.
 *
 * NOTE: the exact v4 credit event name and payload shape must be confirmed against
 * Flutterwave (sandbox/live) — extraction below is deliberately tolerant of field
 * placement; unmatched or unrecognised events are logged/audited, never guessed.
 */
@Controller('webhooks/flutterwave/v4')
export class FlutterwaveV4Controller {
  private readonly logger = new Logger(FlutterwaveV4Controller.name);

  constructor(
    private readonly config: ConfigService,
    private readonly wallets: WalletsRepository,
    private readonly audit: AuditRepository,
    private readonly funding: WalletFundingService,
  ) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Body() body: unknown): { status: string } {
    const secret = this.config.get<string>('FLW_V4_WEBHOOK_SECRET_HASH');
    const signature = req.headers['flutterwave-signature'] as string | undefined;
    if (!secret || !req.rawBody || !this.verify(req.rawBody, signature, secret)) {
      throw new ForbiddenException('invalid flutterwave-signature');
    }
    void this.process(body as V4Webhook);
    return { status: 'ok' };
  }

  /** HMAC-SHA256 hex of the raw body, timing-safe compared against the header. */
  private verify(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
    if (!signature) return false;
    const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(computed);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async process(body: V4Webhook): Promise<void> {
    const event = (body?.type ?? body?.event ?? '').toLowerCase();
    try {
      // A virtual account received money. v4 event naming is not final, so accept
      // the recognised credit shapes and rely on the payload having an account no.
      const isCredit =
        event.includes('virtual') || event.includes('charge') || event.includes('credit');
      if (!isCredit) {
        this.logger.log(`unhandled Flutterwave v4 event: ${event || '(none)'}`);
        return;
      }
      await this.handleCredit(body.data ?? {});
    } catch (err) {
      this.logger.error(`Flutterwave v4 ${event} processing failed: ${(err as Error).message}`);
    }
  }

  private async handleCredit(data: V4Data): Promise<void> {
    const status = (data.status ?? '').toLowerCase();
    if (status && !['succeeded', 'successful', 'success', 'completed'].includes(status)) {
      this.logger.log(`v4 credit not successful (status=${status}) — skipped`);
      return;
    }

    const accountNumber = (
      data.account_number ??
      data.virtual_account?.account_number ??
      data.meta?.account_number ??
      ''
    ).trim();
    const providerRef = data.id ? String(data.id) : (data.reference ?? '').trim();
    const amount = Number(data.amount ?? 0);
    const currency = data.currency ?? 'NGN';

    if (!accountNumber || !providerRef || !(amount > 0)) {
      this.logger.warn(`v4 credit missing fields (acct=${accountNumber || '—'} ref=${providerRef || '—'})`);
      await this.audit.record({ action: 'funding_unmatched', entity: 'transaction', metadata: { providerRef } });
      return;
    }

    const wallet = await this.wallets.findByVirtualAccountNumber(accountNumber);
    if (!wallet) {
      this.logger.warn(`v4 funding unmatched: account=${accountNumber} amount=${amount} — manual reconcile`);
      await this.audit.record({
        action: 'funding_unmatched',
        entity: 'transaction',
        metadata: { accountNumber, providerRef },
      });
      return;
    }
    if (currency !== wallet.currency) {
      this.logger.warn(`v4 funding currency mismatch wallet=${wallet.currency} credit=${currency}`);
      return;
    }

    await this.funding.creditInbound({
      wallet,
      amount,
      currency: wallet.currency as Currency,
      providerRef,
      source: 'bank_transfer',
    });
  }
}

/** Tolerant shape for the v4 webhook envelope (fields confirmed against FLW later). */
interface V4Webhook {
  type?: string;
  event?: string;
  data?: V4Data;
}

interface V4Data {
  id?: number | string;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  account_number?: string;
  virtual_account?: { account_number?: string };
  meta?: { account_number?: string };
}
