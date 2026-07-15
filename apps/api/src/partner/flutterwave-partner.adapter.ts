import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Currency, NameEnquiryResult } from '@guildpay/shared';
import type {
  BalanceResult,
  Bank,
  BankTransferRequest,
  CreateVirtualAccountRequest,
  CreateVirtualAccountResult,
  Dispute,
  IdentityVerificationRequest,
  IdentityVerificationResult,
  ListPage,
  MerchantBalance,
  MerchantOpsAdapter,
  PartnerAdapter,
  Settlement,
  TransferResult,
} from './partner-adapter';

/** Flutterwave v3 wraps every response in { status, message, data }. */
interface FlwEnvelope<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
}

const DEFAULT_BASE_URL = 'https://api.flutterwave.com/v3';

/**
 * FlutterwavePartnerAdapter — NGN rail via the Flutterwave v3 API.
 *
 * The same base URL + secret key serve sandbox (FLWSECK_TEST-…) and live
 * (FLWSECK-…); "going live" is a key swap plus enabling permanent virtual
 * accounts + BVN lookups on the account (see docs/05 §1.5/§4). Keys come from
 * env only. Money-moving methods (`bankTransfer`) are OTP/PIN-gated by the
 * caller per the `no-otp-no-money` rule.
 */
@Injectable()
export class FlutterwavePartnerAdapter implements PartnerAdapter, MerchantOpsAdapter {
  readonly currency: Currency = 'NGN';
  private readonly logger = new Logger(FlutterwavePartnerAdapter.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Create a permanent NUBAN. Live permanent accounts require `bvn`; Flutterwave
   * validates the BVN here and rejects a mismatch, so this doubles as BVN verification.
   */
  async createVirtualAccount(req: CreateVirtualAccountRequest): Promise<CreateVirtualAccountResult> {
    const fullName = [req.firstName, req.lastName].filter(Boolean).join(' ') || req.userRef;
    const data = await this.flw<{
      account_number: string;
      bank_name: string;
      order_ref?: string;
      flw_ref?: string;
    }>('POST', '/virtual-account-numbers', {
      email: req.email,
      tx_ref: req.userRef,
      is_permanent: true,
      bvn: req.bvn,
      phonenumber: req.phone,
      firstname: req.firstName,
      lastname: req.lastName,
      narration: `GuildPay/${fullName}`,
    });
    return {
      accountNumber: data.account_number,
      bankName: data.bank_name,
      providerRef: data.order_ref ?? data.flw_ref ?? req.userRef,
    };
  }

  /** List NGN banks (code + name) for resolving a bank name to its NIP code. */
  async listBanks(): Promise<Bank[]> {
    const data = await this.flw<Array<{ code: string; name: string }>>('GET', '/banks/NG');
    return data.map((b) => ({ code: b.code, name: b.name }));
  }

  /** Resolve the account holder's name before a payout (NIP name enquiry). */
  async nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryResult> {
    const data = await this.flw<{ account_name: string }>('POST', '/accounts/resolve', {
      account_number: accountNumber,
      account_bank: bankCode,
    });
    return { accountNumber, bankCode, accountName: data.account_name };
  }

  /**
   * Verify a government ID (BVN/NIN). Read-only KYC check — never moves money.
   * BVN uses Flutterwave's consent flow (`POST /bvn/verifications`): it returns a
   * URL the user completes, and the final result arrives via the
   * `bvn.verification.completed` webhook — so status here is `pending`. NIN uses
   * the identity lookup (`GET /kyc/nin/:nin`) which resolves synchronously.
   * The raw ID never appears in a log line or the returned message.
   */
  async verifyIdentity(req: IdentityVerificationRequest): Promise<IdentityVerificationResult> {
    if (req.type === 'bvn') {
      const redirectUrl = req.redirectUrl ?? this.config.get<string>('FLW_BVN_REDIRECT_URL');
      const data = await this.flw<{ reference?: string; url?: string; status?: string }>(
        'POST',
        '/bvn/verifications',
        {
          bvn: req.idNumber,
          firstname: req.firstName,
          lastname: req.lastName,
          redirect_url: redirectUrl,
        },
      );
      return {
        type: 'bvn',
        // A consent URL means the user must still approve → pending.
        status: data.url ? 'pending' : mapKycStatus(data.status),
        reference: data.reference,
        consentUrl: data.url,
        message: data.url ? 'Awaiting BVN consent' : undefined,
      };
    }

    // NIN — synchronous identity lookup.
    const data = await this.flw<{
      status?: string;
      first_name?: string;
      last_name?: string;
    }>('GET', `/kyc/nin/${encodeURIComponent(req.idNumber)}`);
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || undefined;
    return { type: 'nin', status: mapKycStatus(data.status), name };
  }

  /** Send money to an external bank (NIP). Final status arrives via the transfer.completed webhook. */
  async bankTransfer(req: BankTransferRequest): Promise<TransferResult> {
    const data = await this.flw<{ id: number; reference?: string; status?: string }>(
      'POST',
      '/transfers',
      {
        account_bank: req.bankCode,
        account_number: req.accountNumber,
        amount: req.amount,
        currency: 'NGN',
        debit_currency: 'NGN',
        narration: req.narration ?? 'GuildPay transfer',
        reference: req.transactionId,
      },
    );
    return {
      providerRef: String(data.id ?? data.reference ?? req.transactionId),
      status: mapTransferStatus(data.status),
      raw: data,
    };
  }

  /**
   * Re-verify a charge referenced by a `charge.completed` webhook before crediting
   * the ledger — never trust the webhook body's amount/status alone.
   */
  async verifyTransaction(
    id: string | number,
  ): Promise<{ status: string; amount: number; currency: string; txRef: string }> {
    const data = await this.flw<{ status: string; amount: number; currency: string; tx_ref: string }>(
      'GET',
      `/transactions/${id}/verify`,
    );
    return { status: data.status, amount: data.amount, currency: data.currency, txRef: data.tx_ref };
  }

  async fund(_accountRef: string, _amount: number): Promise<TransferResult> {
    // NGN funding is inbound: the customer deposits into their NUBAN and Flutterwave
    // fires charge.completed. Confirm with verifyTransaction() in the webhook, then
    // credit via WalletService. There is no server-initiated "fund" on the live rail.
    throw new Error(
      'NGN funding is inbound only — confirm via the charge.completed webhook + verifyTransaction().',
    );
  }

  async getBalance(_accountRef: string): Promise<BalanceResult> {
    // Per-user balances are owned by WalletService (the ledger). Flutterwave /balances
    // returns the pooled merchant float, which is not a user balance.
    throw new Error('Per-user balance comes from WalletService (ledger), not Flutterwave.');
  }

  // ── Merchant operations (admin dashboard) ──────────────────────────────────

  /** Merchant float across every settlement currency (GET /balances). */
  async getBalances(): Promise<MerchantBalance[]> {
    const data = await this.flw<
      Array<{ currency: string; available_balance: number; ledger_balance: number }>
    >('GET', '/balances');
    return data.map((b) => ({
      currency: b.currency,
      availableBalance: Number(b.available_balance ?? 0),
      ledgerBalance: Number(b.ledger_balance ?? 0),
    }));
  }

  /** Settlements from Flutterwave into the corporate bank account (GET /settlements). */
  async listSettlements(page?: ListPage): Promise<Settlement[]> {
    const data = await this.flw<FlwSettlement[]>('GET', withQuery('/settlements', page));
    return data.map(mapSettlement);
  }

  async getSettlement(id: string): Promise<Settlement> {
    const data = await this.flw<FlwSettlement>('GET', `/settlements/${encodeURIComponent(id)}`);
    return mapSettlement(data);
  }

  /** Chargebacks/disputes raised by customers (GET /disputes). */
  async listDisputes(page?: ListPage): Promise<Dispute[]> {
    // FLW paginates disputes as { disputes: [...] } under data.
    const data = await this.flw<{ disputes?: FlwDispute[] }>('GET', withQuery('/disputes', page));
    return (data.disputes ?? []).map(mapDispute);
  }

  async getDispute(id: string): Promise<Dispute> {
    const data = await this.flw<FlwDispute>('GET', `/disputes/${encodeURIComponent(id)}`);
    return mapDispute(data);
  }

  private async flw<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const key = this.config.get<string>('FLW_SECRET_KEY');
    if (!key) throw new Error('FLW_SECRET_KEY is not set');
    const base = this.config.get<string>('FLW_BASE_URL') ?? DEFAULT_BASE_URL;

    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(pruneUndefined(body)),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<FlwEnvelope<T>>;
    if (!res.ok || json.status === 'error') {
      // Never log the request body — it may carry BVN / account numbers.
      this.logger.warn(`Flutterwave ${method} ${path} -> ${res.status} ${json.message ?? ''}`);
      throw new Error(`Flutterwave ${method} ${path} failed: ${json.message ?? res.statusText}`);
    }
    return json.data as T;
  }
}

function mapTransferStatus(status: string | undefined): TransferResult['status'] {
  switch ((status ?? '').toUpperCase()) {
    case 'SUCCESSFUL':
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

function mapKycStatus(status: string | undefined): IdentityVerificationResult['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'verified':
    case 'completed':
    case 'success':
    case 'successful':
      return 'verified';
    case 'failed':
    case 'rejected':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Raw Flutterwave shapes we map into our neutral Settlement/Dispute. */
interface FlwSettlement {
  id: number | string;
  status?: string;
  currency?: string;
  gross_amount?: number;
  app_fee?: number;
  merchant_fee?: number;
  net_amount?: number;
  due_date?: string;
  created_at?: string;
  bank_name?: string;
  account_number?: string;
}

interface FlwDispute {
  id: number | string;
  status?: string;
  currency?: string;
  amount?: number;
  reason?: string;
  customer?: { email?: string };
  customer_email?: string;
  due_date?: string;
  created_at?: string;
  tx_ref?: string;
}

function mapSettlement(s: FlwSettlement): Settlement {
  return {
    id: String(s.id),
    status: s.status ?? 'unknown',
    currency: s.currency ?? '',
    grossAmount: Number(s.gross_amount ?? 0),
    appFee: Number(s.app_fee ?? 0),
    merchantFee: Number(s.merchant_fee ?? 0),
    netAmount: Number(s.net_amount ?? 0),
    dueDate: s.due_date ?? null,
    createdAt: s.created_at ?? null,
    bankName: s.bank_name ?? null,
    accountNumber: s.account_number ?? null,
  };
}

function mapDispute(d: FlwDispute): Dispute {
  return {
    id: String(d.id),
    status: d.status ?? 'unknown',
    currency: d.currency ?? '',
    amount: Number(d.amount ?? 0),
    reason: d.reason ?? null,
    customerEmail: d.customer?.email ?? d.customer_email ?? null,
    dueDate: d.due_date ?? null,
    createdAt: d.created_at ?? null,
    txRef: d.tx_ref ?? null,
  };
}

/** Append ?page=&status= to a path, skipping undefined params. */
function withQuery(path: string, page?: ListPage): string {
  if (!page) return path;
  const q = new URLSearchParams();
  if (page.page) q.set('page', String(page.page));
  if (page.status) q.set('status', page.status);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Drop undefined keys so optional fields (bvn, phone) aren't sent as null. */
function pruneUndefined(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined));
}
