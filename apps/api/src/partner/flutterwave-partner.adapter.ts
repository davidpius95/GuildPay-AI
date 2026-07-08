import { Injectable } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import type {
  BalanceResult,
  PartnerAdapter,
  TransferRequest,
  TransferResult,
} from './partner-adapter';

/**
 * FlutterwaveAdapter — NGN rail via the Flutterwave sandbox.
 *
 * Week 0 stub only: defines the contract so the currency abstraction is real.
 * The sandbox integration (Transfers API, virtual accounts, webhook
 * verification) is a dedicated build-plan item — see the Naira plan.
 * Keys come from env (FLW_SECRET_KEY / FLW_ENCRYPTION_KEY), never hardcoded.
 */
@Injectable()
export class FlutterwavePartnerAdapter implements PartnerAdapter {
  readonly currency: Currency = 'NGN';

  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    throw new Error('FlutterwavePartnerAdapter not implemented yet (Naira feature).');
  }

  async completeTransfer(_req: TransferRequest): Promise<TransferResult> {
    throw new Error('FlutterwavePartnerAdapter not implemented yet (Naira feature).');
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    throw new Error('FlutterwavePartnerAdapter not implemented yet (Naira feature).');
  }
}
