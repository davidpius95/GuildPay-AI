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
 * Flutterwave (live) — extraction below is deliberately tolerant of field
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
    if (!secret || !req.rawBody || !this.verify(req.rawBody, req.headers, secret)) {
      throw new ForbiddenException('invalid flutterwave-signature');
    }
    void this.process(body as V4Webhook);
    return { status: 'ok' };
  }

  /**
   * Verify the webhook is genuinely from Flutterwave. v4 is delivered via Svix and
   * carries a base64 `flutterwave-signature` (and Svix headers). We compute
   * HMAC-SHA256 of the raw body with the secret and accept a match against the
   * signature — trying base64/hex digests and a few secret encodings, plus the
   * Svix message form (`id.timestamp.body`), so we accept the real signature
   * regardless of the exact encoding. Any match still requires knowing the secret.
   */
  private verify(rawBody: Buffer, headers: Request['headers'], secret: string): boolean {
    const flwSig = (headers['flutterwave-signature'] as string | undefined)?.trim();
    const svixSig = (headers['svix-signature'] as string | undefined)?.trim();
    const svixId = headers['svix-id'] as string | undefined;
    const svixTs = headers['svix-timestamp'] as string | undefined;

    // Candidate signatures from the request (svix-signature is "v1,<sig> v2,<sig>").
    const provided = new Set<string>();
    if (flwSig) provided.add(flwSig);
    if (svixSig) for (const part of svixSig.split(/\s+/)) provided.add(part.replace(/^v\d+,/, ''));
    if (provided.size === 0) return false;

    // Candidate secret keys (the hash may be given as raw text, hex, or base64).
    const keys: Buffer[] = [Buffer.from(secret)];
    if (/^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0) keys.push(Buffer.from(secret, 'hex'));
    try {
      keys.push(Buffer.from(secret.replace(/^whsec_/, ''), 'base64'));
    } catch {
      /* ignore */
    }

    // Candidate signed messages: the raw body, and the Svix form id.timestamp.body.
    const messages: Buffer[] = [rawBody];
    if (svixId && svixTs) messages.push(Buffer.from(`${svixId}.${svixTs}.${rawBody.toString('utf8')}`));

    for (const key of keys) {
      for (const message of messages) {
        for (const enc of ['base64', 'hex'] as const) {
          const computed = createHmac('sha256', key).update(message).digest(enc);
          for (const sig of provided) {
            if (computed.length === sig.length && timingSafeEqual(Buffer.from(computed), Buffer.from(sig))) {
              return true;
            }
          }
        }
      }
    }
    this.logger.warn(`v4 webhook signature mismatch (recv sample: ${[...provided][0]?.slice(0, 10)}…)`);
    return false;
  }

  private async process(body: V4Webhook): Promise<void> {
    const event = (body?.type ?? body?.event ?? '').toLowerCase();
    const data = body?.data ?? {};
    // Signature already authenticated the sender. Log a safe summary (never the NUBAN).
    this.logger.log(
      `v4 webhook: event=${event || '(none)'} ref=${data.reference ?? '—'} amount=${data.amount ?? '—'} status=${data.status ?? '—'}`,
    );
    try {
      // Any authenticated, successful money-in with a reference/account is a credit.
      if (Number(data.amount) > 0 && (data.reference || data.account_number)) {
        await this.handleCredit(data);
      } else {
        this.logger.log(`v4 event ignored (not a credit): ${event || '(none)'}`);
      }
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

    // v4 charge payloads carry our wallet reference (GPA-NG-…) as `reference`; the
    // destination NUBAN isn't a clean field, so match by reference first.
    const reference = (data.reference ?? '').trim();
    const accountNumber = (data.account_number ?? data.virtual_account?.account_number ?? '').trim();
    const providerRef = data.id ? String(data.id) : reference;
    const amount = Number(data.amount ?? 0);

    if (!(amount > 0) || !providerRef) {
      this.logger.warn('v4 credit missing amount/ref — skipped');
      await this.audit.record({ action: 'funding_unmatched', entity: 'transaction', metadata: { providerRef } });
      return;
    }

    let wallet = reference ? await this.wallets.findByReference(reference.toUpperCase()) : null;
    if (!wallet && accountNumber) wallet = await this.wallets.findByVirtualAccountNumber(accountNumber);
    if (!wallet) {
      this.logger.warn(`v4 funding unmatched: ref=${reference || '—'} amount=${amount} — manual reconcile`);
      await this.audit.record({
        action: 'funding_unmatched',
        entity: 'transaction',
        metadata: { reference, providerRef },
      });
      return;
    }

    const currency = data.currency ?? wallet.currency;
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
