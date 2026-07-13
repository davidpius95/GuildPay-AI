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

const NOT_YET = 'MockPartnerAdapter (QAR) not implemented until M2 (WalletService + ledger).';

/**
 * MockPartnerAdapter — QAR rail on the internal simulated ledger.
 * QAR supports wallet + P2P + internal transfer only (no NIP/bills). Week 0 stub;
 * real Postgres-backed implementation lands in M2.
 */
@Injectable()
export class MockPartnerAdapter implements PartnerAdapter {
  readonly currency: Currency = 'QAR';

  async createVirtualAccount(_req: CreateVirtualAccountRequest): Promise<CreateVirtualAccountResult> {
    throw new Error(NOT_YET);
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

  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    throw new Error(NOT_YET);
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    throw new Error(NOT_YET);
  }
}
