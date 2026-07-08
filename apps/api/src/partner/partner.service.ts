import { Injectable } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import type { PartnerAdapter } from './partner-adapter';
import { MockPartnerAdapter } from './mock-partner.adapter';
import { FlutterwavePartnerAdapter } from './flutterwave-partner.adapter';

/**
 * Routes a transaction to the PartnerAdapter for its settlement currency.
 * Flows resolve an adapter here rather than newing one up, so adding a rail
 * (or swapping Mock -> licensed partner) is a one-line registration change.
 */
@Injectable()
export class PartnerService {
  private readonly adapters: Map<Currency, PartnerAdapter>;

  constructor(mock: MockPartnerAdapter, flutterwave: FlutterwavePartnerAdapter) {
    this.adapters = new Map<Currency, PartnerAdapter>([
      [mock.currency, mock],
      [flutterwave.currency, flutterwave],
    ]);
  }

  forCurrency(currency: Currency): PartnerAdapter {
    const adapter = this.adapters.get(currency);
    if (!adapter) {
      throw new Error(`No PartnerAdapter registered for currency ${currency}`);
    }
    return adapter;
  }
}
