import type { Market } from '@guildpay/shared';

/**
 * BillsAdapter — the boundary for VTU (airtime, data, and bill payments:
 * electricity / cable TV / betting). Kept separate from PartnerAdapter because
 * VTU billers are a different provider surface. NGN → FlutterwaveBillsAdapter.
 *
 * All methods are prepared by a capability module and executed only after OTP/PIN
 * (`no-otp-no-money`). `validateCustomer` (e.g. meter/smartcard lookup) is the
 * bills equivalent of name enquiry and MUST run before `payBill`.
 */
export interface Biller {
  id: string;
  name: string;
  category: 'airtime' | 'data' | 'electricity' | 'cable' | 'betting';
}

export interface CustomerValidation {
  customerId: string;
  customerName: string;
  billerId: string;
}

export interface VendRequest {
  transactionId: string;
  fromAccountRef: string;
  amount: number;
}

export interface AirtimeRequest extends VendRequest {
  phoneNumber: string;
  network: string; // mtn | glo | airtel | 9mobile
}

export interface DataRequest extends AirtimeRequest {
  planId: string;
}

export interface BillRequest extends VendRequest {
  billerId: string;
  customerId: string;
}

export interface VendResult {
  providerRef: string;
  status: 'completed' | 'pending' | 'failed';
  token?: string; // e.g. prepaid electricity token
  raw?: unknown;
}

export interface BillsAdapter {
  readonly market: Market;
  listBillers(category: Biller['category']): Promise<Biller[]>;
  validateCustomer(billerId: string, customerId: string): Promise<CustomerValidation>;
  buyAirtime(req: AirtimeRequest): Promise<VendResult>;
  buyData(req: DataRequest): Promise<VendResult>;
  payBill(req: BillRequest): Promise<VendResult>;
}
