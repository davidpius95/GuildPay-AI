import { Injectable } from '@nestjs/common';
import type { Currency, NameEnquiryResult } from '@guildpay/shared';
import type {
  BalanceResult,
  Bank,
  BankTransferRequest,
  CreateVirtualAccountRequest,
  CreateVirtualAccountResult,
  PartnerAdapter,
  TransferResult,
} from './partner-adapter';

/**
 * MockPartnerAdapter — QAR rail on the internal simulated ledger (test money).
 * QAR supports wallet + P2P + internal transfer only — no external NIP/bills rail.
 * Provisions a *simulated* account so Qatar is symmetric with Nigeria in the demo;
 * balances remain owned by WalletService (the ledger).
 */
@Injectable()
export class MockPartnerAdapter implements PartnerAdapter {
  readonly currency: Currency = 'QAR';

  /** Deterministic simulated account derived from the wallet reference. */
  async createVirtualAccount(req: CreateVirtualAccountRequest): Promise<CreateVirtualAccountResult> {
    const suffix = req.userRef.replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase() || 'QA0001';
    return {
      accountNumber: `QA-SIM-${suffix}`,
      bankName: 'GuildPay Simulated Bank (QAR)',
      providerRef: `mock-${suffix}`,
    };
  }

  async listBanks(): Promise<Bank[]> {
    throw new Error('QAR has no external bank rail (bank list is NGN-only).');
  }

  async nameEnquiry(_accountNumber: string, _bankCode: string): Promise<NameEnquiryResult> {
    throw new Error('QAR has no external bank rail (name enquiry is NGN-only).');
  }

  async bankTransfer(_req: BankTransferRequest): Promise<TransferResult> {
    throw new Error('QAR has no external bank rail (NIP is NGN-only).');
  }

  /** Simulated inbound funding — the demo ledger credit is done by the caller. */
  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    return { providerRef: `mock-fund-${Date.now()}`, status: 'completed' };
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    throw new Error('Per-user balance comes from WalletService (ledger), not the QAR mock.');
  }
}
