import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlutterwavePartnerAdapter } from '../partner/flutterwave-partner.adapter';
import { FlutterwaveV4Client } from '../partner/flutterwave-v4.client';
import type { Bank, Dispute, ListPage, MerchantBalance, Settlement } from '../partner/partner-adapter';
import type { NameEnquiryResult } from '@guildpay/shared';

/**
 * OpsService — merchant-global operational views for the admin dashboard:
 * Flutterwave merchant float, settlements, and disputes. Thin pass-through to
 * the FlutterwavePartnerAdapter (the MerchantOpsAdapter for NGN) so the CLAUDE.md
 * rule holds: no controller/module ever calls Flutterwave directly. Read-only.
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly flw: FlutterwavePartnerAdapter,
    private readonly v4: FlutterwaveV4Client,
    private readonly config: ConfigService,
  ) {}

  /** True when v4 credentials are configured (merchant balance can use v4). */
  private v4Enabled(): boolean {
    return Boolean(
      this.config.get<string>('FLW_V4_CLIENT_ID') && this.config.get<string>('FLW_V4_CLIENT_SECRET'),
    );
  }

  /** Merchant float for the dashboard — from v4 when configured, else v3. */
  async getBalances(): Promise<MerchantBalance[]> {
    if (this.v4Enabled()) {
      try {
        return await this.v4.getMerchantBalances();
      } catch (err) {
        this.logger.warn(`v4 balances failed, falling back to v3: ${(err as Error).message}`);
      }
    }
    return this.flw.getBalances();
  }

  listSettlements(page?: ListPage): Promise<Settlement[]> {
    return this.flw.listSettlements(page);
  }

  getSettlement(id: string): Promise<Settlement> {
    return this.flw.getSettlement(id);
  }

  listDisputes(page?: ListPage): Promise<Dispute[]> {
    return this.flw.listDisputes(page);
  }

  getDispute(id: string): Promise<Dispute> {
    return this.flw.getDispute(id);
  }

  /** Banks for the NGN rail — used to populate the name-enquiry lookup tool. */
  listBanks(): Promise<Bank[]> {
    return this.flw.listBanks();
  }

  /**
   * Resolve an account holder's name for a bank + account number. Read-only
   * lookup (the same check a payout uses) so admins can verify an account without
   * sending money.
   */
  nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryResult> {
    return this.flw.nameEnquiry(accountNumber, bankCode);
  }
}
