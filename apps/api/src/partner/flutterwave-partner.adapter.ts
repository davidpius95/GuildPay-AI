import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Currency, NameEnquiryResult } from '@guildpay/shared';
import type {
  BalanceResult,
  BankTransferRequest,
  CreateVirtualAccountRequest,
  CreateVirtualAccountResult,
  PartnerAdapter,
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
export class FlutterwavePartnerAdapter implements PartnerAdapter {
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

  /** Resolve the account holder's name before a payout (NIP name enquiry). */
  async nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryResult> {
    const data = await this.flw<{ account_name: string }>('POST', '/accounts/resolve', {
      account_number: accountNumber,
      account_bank: bankCode,
    });
    return { accountNumber, bankCode, accountName: data.account_name };
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

/** Drop undefined keys so optional fields (bvn, phone) aren't sent as null. */
function pruneUndefined(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).filter(([, v]) => v !== undefined));
}
