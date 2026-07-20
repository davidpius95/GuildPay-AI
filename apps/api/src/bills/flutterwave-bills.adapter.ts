import { Injectable } from '@nestjs/common';
import type { Market } from '@guildpay/shared';
import type {
  AirtimeRequest,
  Biller,
  BillRequest,
  BillsAdapter,
  CustomerValidation,
  DataRequest,
  VendResult,
} from './bills-adapter';

const NOT_YET = 'FlutterwaveBillsAdapter not implemented yet (Week 2.5 — M6a/M6b).';

/**
 * FlutterwaveBillsAdapter — NGN airtime/data/bills via the Flutterwave Bills API
 * (same FLW_* keys as the payments adapter). Week 0 contract stub.
 */
@Injectable()
export class FlutterwaveBillsAdapter implements BillsAdapter {
  readonly market: Market = 'NG';

  async listBillers(_category: Biller['category']): Promise<Biller[]> {
    throw new Error(NOT_YET);
  }

  async validateCustomer(_billerId: string, _customerId: string): Promise<CustomerValidation> {
    throw new Error(NOT_YET);
  }

  async buyAirtime(_req: AirtimeRequest): Promise<VendResult> {
    throw new Error(NOT_YET);
  }

  async buyData(_req: DataRequest): Promise<VendResult> {
    throw new Error(NOT_YET);
  }

  async payBill(_req: BillRequest): Promise<VendResult> {
    throw new Error(NOT_YET);
  }
}
