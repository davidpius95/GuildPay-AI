import { Injectable } from '@nestjs/common';
import type { Currency, NameEnquiryResult } from '@guildpay/shared';
import type {
  BalanceResult,
  BankTransferRequest,
  CreateVirtualAccountResult,
  PartnerAdapter,
  TransferResult,
} from './partner-adapter';

const NOT_YET = 'FlutterwavePartnerAdapter not implemented yet (Week 2.5 NGN rail).';

/**
 * FlutterwavePartnerAdapter — NGN rail via the Flutterwave sandbox.
 *
 * Week 0 stub: defines the contract so the currency abstraction is real. The
 * sandbox integration (virtual NUBAN accounts, name enquiry, Transfers/NIP,
 * webhook `verif-hash`) lands in Week 2.5. Keys from env (FLW_*), never hardcoded.
 */
@Injectable()
export class FlutterwavePartnerAdapter implements PartnerAdapter {
  readonly currency: Currency = 'NGN';

  async createVirtualAccount(_userRef: string): Promise<CreateVirtualAccountResult> {
    throw new Error(NOT_YET);
  }

  async nameEnquiry(_accountNumber: string, _bankCode: string): Promise<NameEnquiryResult> {
    throw new Error(NOT_YET);
  }

  async bankTransfer(_req: BankTransferRequest): Promise<TransferResult> {
    throw new Error(NOT_YET);
  }

  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    throw new Error(NOT_YET);
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    throw new Error(NOT_YET);
  }
}
