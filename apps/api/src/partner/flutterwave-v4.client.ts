import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlutterwaveV4TokenService } from './flutterwave-v4-token.service';
import type { MerchantBalance } from './partner-adapter';

const DEFAULT_BASE_URL = 'https://f4bexperience.flutterwave.com';

/** Fallback issuing-bank names by NIP code, when the v4 response omits the name. */
const V4_BANK_NAMES: Record<string, string> = {
  '035': 'WEMA BANK',
  '232': 'STERLING BANK',
};

export interface V4CreateCustomer {
  email: string;
  firstName?: string;
  lastName?: string;
  /** E.164-ish phone; split into {country_code, number} for the v4 payload. */
  phone?: string;
}

export interface V4CreateVirtualAccount {
  reference: string;
  customerId: string;
  bvn?: string;
  bankCode: string;
  /** Display name shown when the account is resolved (so senders see the user). */
  narration?: string;
}

export interface V4VirtualAccountResult {
  accountNumber: string;
  bankName: string;
  providerRef: string;
}

/**
 * Thin client for the Flutterwave v4 Wallets API, used only to create virtual
 * accounts on a chosen issuing bank (Wema 035 / Sterling 232) — a capability v3
 * lacks. Auth is a short-lived OAuth bearer from FlutterwaveV4TokenService (not
 * the v3 secret key). Every request carries an idempotency key so a retry never
 * double-creates a customer or account. Request bodies (which carry BVN/PII) are
 * never logged.
 */
@Injectable()
export class FlutterwaveV4Client {
  private readonly logger = new Logger(FlutterwaveV4Client.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: FlutterwaveV4TokenService,
  ) {}

  /**
   * Create a customer and return its id (required before creating a virtual
   * account). v4 requires `name` and `phone` as objects, not strings — a flat
   * string is rejected with "Malformed request".
   */
  async createCustomer(req: V4CreateCustomer, idempotencyKey: string): Promise<{ id: string }> {
    const name =
      req.firstName || req.lastName ? { first: req.firstName, last: req.lastName } : undefined;
    const phone = req.phone ? splitPhone(req.phone) : undefined;
    try {
      const data = await this.request<{ id?: string; customer_id?: string }>(
        'POST',
        '/customers',
        { email: req.email, name, phone },
        idempotencyKey,
      );
      const id = data.id ?? data.customer_id;
      if (!id) throw new Error('FLW v4 createCustomer returned no id');
      return { id };
    } catch (err) {
      // A repeat onboarding hits the same email — Flutterwave enforces one customer
      // per email and returns 409 "Customer already exists". That must NOT fail
      // onboarding: recover the existing customer id (from the 409 body, else by
      // email lookup) and carry on to create the virtual account.
      if (err instanceof FlwV4Error && err.status === 409) {
        const existing = extractCustomerId(err.body) ?? (await this.findCustomerIdByEmail(req.email));
        if (existing) {
          this.logger.log('FLW v4 customer already existed — reusing existing customer id');
          return { id: existing };
        }
        this.logger.warn(`FLW v4 customer 409 but could not recover id; body=${safeJson(err.body)}`);
      }
      throw err;
    }
  }

  /** Find an existing customer's id by email (used to recover from a 409 on create). */
  private async findCustomerIdByEmail(email: string): Promise<string | undefined> {
    try {
      const data = await this.request<unknown>(
        'GET',
        `/customers?email=${encodeURIComponent(email)}`,
        undefined,
        randomUUID(),
      );
      const list: Array<Record<string, unknown>> = Array.isArray(data)
        ? (data as Array<Record<string, unknown>>)
        : (((data as { data?: unknown })?.data as Array<Record<string, unknown>>) ?? []);
      const match =
        list.find((c) => String(c.email ?? '').toLowerCase() === email.toLowerCase()) ?? list[0];
      return match ? extractCustomerId(match) : undefined;
    } catch (e) {
      this.logger.warn(`FLW v4 customer email lookup failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Create a static NGN virtual account on the given bank_code, for a customer. */
  async createVirtualAccount(req: V4CreateVirtualAccount): Promise<V4VirtualAccountResult> {
    const data = await this.request<{
      account_number?: string;
      account_bank_name?: string; // v4's field for the issuing bank name
      bank_name?: string;
      id?: string;
      reference?: string;
    }>(
      'POST',
      '/virtual-accounts',
      {
        reference: req.reference,
        customer_id: req.customerId,
        amount: 0, // 0 = static/permanent account
        currency: 'NGN',
        account_type: 'static',
        bvn: req.bvn,
        bank_code: req.bankCode,
        narration: req.narration,
      },
      req.reference,
    );
    if (!data.account_number) throw new Error('FLW v4 createVirtualAccount returned no account_number');
    return {
      accountNumber: data.account_number,
      // v4 returns the issuing bank as `account_bank_name`; fall back to the known
      // name for the requested bank_code so the user always sees a bank name.
      bankName: data.account_bank_name ?? data.bank_name ?? V4_BANK_NAMES[req.bankCode] ?? '',
      providerRef: data.id ?? data.reference ?? req.reference,
    };
  }

  /**
   * Merchant wallet balances (float) for the admin dashboard. Read-only. v4 returns
   * one row per currency with an available balance; we map to the neutral
   * MerchantBalance shape the dashboard already renders.
   */
  async getMerchantBalances(): Promise<MerchantBalance[]> {
    const data = await this.request<
      Array<{ currency?: string; available_balance?: number; ledger_balance?: number }>
    >('GET', '/wallets/balances', undefined, randomUUID());
    return (data ?? [])
      .map((w) => ({
        currency: w.currency ?? '',
        availableBalance: Number(w.available_balance ?? 0),
        ledgerBalance: Number(w.ledger_balance ?? w.available_balance ?? 0),
      }))
      // v4 lists ~70 currencies; keep the markets we run plus any with a balance.
      .filter(
        (b) =>
          b.currency === 'NGN' ||
          b.currency === 'QAR' ||
          b.availableBalance !== 0 ||
          b.ledgerBalance !== 0,
      );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    idempotencyKey: string,
  ): Promise<T> {
    const base = this.config.get<string>('FLW_V4_BASE_URL') ?? DEFAULT_BASE_URL;
    const token = await this.tokens.getToken();

    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Trace-Id': randomUUID(),
        'X-Idempotency-Key': idempotencyKey,
      },
      body: body === undefined ? undefined : JSON.stringify(pruneUndefined(body)),
    });

    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      error?: { message?: string };
      data?: T;
    };
    if (!res.ok || json.status === 'error' || json.status === 'failed') {
      // Never log the request body — it may carry BVN / account numbers.
      const msg = json.message ?? json.error?.message ?? res.statusText;
      this.logger.warn(`FLW v4 ${method} ${path} -> ${res.status} ${msg}`);
      throw new FlwV4Error(`FLW v4 ${method} ${path} failed: ${msg}`, res.status, json);
    }
    // v4 responses may or may not wrap the payload in { data }.
    return (json.data ?? (json as unknown)) as T;
  }
}

/** Error from the v4 API that keeps the HTTP status + parsed body so callers can recover (e.g. 409). */
class FlwV4Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'FlwV4Error';
  }
}

/** Drop undefined keys so optional fields (bvn, phone) aren't sent as null. */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Pull a customer id out of a v4 payload/error body, tolerant of where it sits. */
function extractCustomerId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const data = (b.data ?? b.meta ?? b.error) as Record<string, unknown> | undefined;
  const candidate =
    b.id ?? b.customer_id ?? data?.id ?? data?.customer_id ?? data?.customerId;
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

/** Stringify an error body for logs without throwing on circular refs. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Split an E.164-ish phone into v4's {country_code, number} (NG: 10-digit number). */
function splitPhone(phone: string): { country_code: string; number: string } {
  const digits = phone.replace(/\D/g, '');
  const number = digits.slice(-10);
  const country_code = digits.slice(0, Math.max(0, digits.length - 10)) || '234';
  return { country_code, number };
}
