import 'server-only';

/**
 * Server-side reader for the API's admin endpoints (merchant ops live on the API
 * because only it holds the Flutterwave key). Returns `{ data }` on success or
 * `{ error }` so pages can render a friendly state when Flutterwave keys aren't
 * configured or the call fails — never throws into the render.
 */
export interface MerchantBalance {
  currency: string;
  availableBalance: number;
  ledgerBalance: number;
}

export interface Settlement {
  id: string;
  status: string;
  currency: string;
  grossAmount: number;
  appFee: number;
  merchantFee: number;
  netAmount: number;
  dueDate: string | null;
  createdAt: string | null;
  bankName?: string | null;
  accountNumber?: string | null;
}

export interface Dispute {
  id: string;
  status: string;
  currency: string;
  amount: number;
  reason: string | null;
  customerEmail: string | null;
  dueDate: string | null;
  createdAt: string | null;
  txRef: string | null;
}

export interface ApiResult<T> {
  data: T | null;
  error: string | null;
}

async function get<T>(path: string): Promise<ApiResult<T>> {
  const api = process.env.API_INTERNAL_URL ?? 'http://guildpay-api:3001';
  const token = process.env.ADMIN_API_TOKEN ?? '';
  try {
    const res = await fetch(`${api}${path}`, {
      headers: { 'x-admin-token': token },
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { data: null, error: `API ${res.status}: ${body.slice(0, 200) || res.statusText}` };
    }
    return { data: (await res.json()) as T, error: null };
  } catch (err) {
    return { data: null, error: (err as Error).message };
  }
}

export interface Bank {
  code: string;
  name: string;
}

export interface NameEnquiry {
  accountNumber?: string;
  accountName?: string;
  bankCode?: string;
  error?: string;
}

export const getMerchantBalances = () => get<MerchantBalance[]>('/v1/admin/balances');
export const getSettlements = () => get<Settlement[]>('/v1/admin/settlements');
export const getDisputes = () => get<Dispute[]>('/v1/admin/disputes');
export const getSettlement = (id: string) =>
  get<Settlement>(`/v1/admin/settlements/${encodeURIComponent(id)}`);
export const getDispute = (id: string) =>
  get<Dispute>(`/v1/admin/disputes/${encodeURIComponent(id)}`);
export const getBanks = () => get<Bank[]>('/v1/admin/banks');
export const nameEnquiry = (account: string, bankCode: string) =>
  get<NameEnquiry>(
    `/v1/admin/name-enquiry?account=${encodeURIComponent(account)}&bankCode=${encodeURIComponent(bankCode)}`,
  );
