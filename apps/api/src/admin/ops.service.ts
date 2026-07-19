import { Injectable, Logger } from '@nestjs/common';
import { FlutterwavePartnerAdapter } from '../partner/flutterwave-partner.adapter';
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

  constructor(private readonly flw: FlutterwavePartnerAdapter) {}

  getBalances(): Promise<MerchantBalance[]> {
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
