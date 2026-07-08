import { Injectable } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import type {
  BalanceResult,
  PartnerAdapter,
  TransferRequest,
  TransferResult,
} from './partner-adapter';

/**
 * MockPartnerAdapter — QAR rail on the internal double-entry ledger.
 * Week 0 stub: the real Postgres-backed double-entry implementation lands in
 * M2 (docs/04_BUILD_PLAN.md, Week 1). No real money moves.
 */
@Injectable()
export class MockPartnerAdapter implements PartnerAdapter {
  readonly currency: Currency = 'QAR';

  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    throw new Error('MockPartnerAdapter.fund not implemented until M2 (ledger).');
  }

  async completeTransfer(_req: TransferRequest): Promise<TransferResult> {
    throw new Error('MockPartnerAdapter.completeTransfer not implemented until M2 (ledger).');
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    throw new Error('MockPartnerAdapter.getBalance not implemented until M2 (ledger).');
  }
}
