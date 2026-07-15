import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type { IdentityType } from '../partner/partner-adapter';
import { kycResultCard, maskId } from '../templates/chat-templates';

/**
 * KycService — user-facing identity verification (BVN/NIN) via the currency's
 * PartnerAdapter. Read-only: it verifies an ID and records the outcome, but never
 * moves money, so it needs no OTP gate. Persists the resulting kyc_status and an
 * audit row; the raw ID is never logged or audited (only masked / its type).
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly users: UsersRepository,
    private readonly audit: AuditRepository,
    private readonly partners: PartnerService,
  ) {}

  /** Verify a government ID for the user and reply with a KYC card. */
  async verify(user: UserRow, currency: Currency, type: IdentityType, idNumber: string): Promise<void> {
    const id = idNumber.replace(/\s/g, '');
    if (!/^\d{11}$/.test(id)) {
      await this.text(user.wa_phone, `Please send your 11-digit *${type.toUpperCase()}* (numbers only).`);
      return;
    }

    let result;
    try {
      result = await this.partners.forCurrency(currency).verifyIdentity({
        type,
        idNumber: id,
        firstName: user.first_name ?? undefined,
        lastName: user.last_name ?? undefined,
      });
    } catch (err) {
      // Never include the raw id in a log line.
      this.logger.error(`verifyIdentity ${type} (${maskId(id)}) failed: ${(err as Error).message}`);
      await this.text(user.wa_phone, "I couldn't reach the verification service just now. Please try again shortly.");
      return;
    }

    const kycStatus = result.status === 'verified' ? 'verified' : result.status === 'failed' ? 'failed' : 'pending';
    await this.users.update(user.id, { kyc_status: kycStatus, ...(result.status === 'verified' ? { kyc_id: id } : {}) });
    await this.audit.record({
      userId: user.id,
      action: `kyc_${kycStatus}`,
      entity: 'user',
      entityId: user.id,
      metadata: { type, reference: result.reference ?? null }, // no raw id
    });

    await this.text(user.wa_phone, kycResultCard(result, id));
  }

  private async text(to: string, body: string): Promise<void> {
    await this.channel.send({ to, kind: 'text', body });
  }
}
