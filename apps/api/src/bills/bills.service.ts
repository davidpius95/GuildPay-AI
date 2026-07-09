import { Injectable } from '@nestjs/common';
import type { Market } from '@guildpay/shared';
import type { BillsAdapter } from './bills-adapter';
import { FlutterwaveBillsAdapter } from './flutterwave-bills.adapter';

/**
 * Resolves the BillsAdapter for a market. VTU (airtime/data/bills) is NGN-only in
 * the MVP; QAR requests should never reach here.
 */
@Injectable()
export class BillsService {
  private readonly adapters: Map<Market, BillsAdapter>;

  constructor(flutterwaveBills: FlutterwaveBillsAdapter) {
    this.adapters = new Map<Market, BillsAdapter>([[flutterwaveBills.market, flutterwaveBills]]);
  }

  forMarket(market: Market): BillsAdapter {
    const adapter = this.adapters.get(market);
    if (!adapter) {
      throw new Error(`No BillsAdapter registered for market ${market}`);
    }
    return adapter;
  }
}
