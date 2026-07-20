import type { Currency, NameEnquiryResult } from '@guildpay/shared';

/**
 * PartnerAdapter — the single boundary for external settlement + account services.
 *
 * Capability modules never touch a provider SDK or the ledger directly; they use
 * `WalletService` (internal balances) + a PartnerAdapter (external rail):
 *   - NGN → FlutterwavePartnerAdapter (Flutterwave live rail)
 *   - QAR → MockPartnerAdapter (simulated ledger)
 *
 * The AI PREPARES; only the OTP/PIN verifier calls the money-moving methods
 * (`bankTransfer`, `fund`) — enforced by the `no-otp-no-money` gate.
 * Before any `bankTransfer`, callers MUST `nameEnquiry` and confirm the resolved name.
 */
export interface CreateVirtualAccountRequest {
  /** Internal wallet/user reference — sent as Flutterwave `tx_ref`, must be unique. */
  userRef: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** Required for a permanent NGN NUBAN in live mode; Flutterwave validates it at creation. */
  bvn?: string;
}

export interface CreateVirtualAccountResult {
  accountNumber: string; // NUBAN (NGN) or simulated reference (QAR)
  bankName: string;
  providerRef: string;
}

export interface BankTransferRequest {
  transactionId: string;
  fromAccountRef: string;
  accountNumber: string;
  bankCode: string;
  recipientName: string; // the name confirmed via nameEnquiry
  amount: number;
  narration?: string;
}

export interface TransferResult {
  providerRef: string;
  status: 'completed' | 'pending' | 'failed';
  balanceAfter?: number;
  raw?: unknown;
}

export interface BalanceResult {
  accountRef: string;
  currency: Currency;
  balance: number;
}

export interface Bank {
  code: string;
  name: string;
}

/** Government ID types we can verify for identity/KYC. */
export type IdentityType = 'bvn' | 'nin';

export interface IdentityVerificationRequest {
  type: IdentityType;
  /** Raw 11-digit BVN/NIN. Never logged or audited in full. */
  idNumber: string;
  firstName?: string;
  lastName?: string;
  /** Consent-flow return URL (BVN). Falls back to FLW_BVN_REDIRECT_URL. */
  redirectUrl?: string;
}

export interface IdentityVerificationResult {
  type: IdentityType;
  /** verified: matched now; pending: consent/async flow started; failed: mismatch/error. */
  status: 'verified' | 'pending' | 'failed';
  /** Provider reference for the verification (safe to store/audit). */
  reference?: string;
  /** Resolved holder name when the provider returns it. */
  name?: string;
  /** For BVN consent flows: URL the user completes verification at. */
  consentUrl?: string;
  /** Human-readable note (e.g. mismatch reason). Never contains the raw ID. */
  message?: string;
}

export interface PartnerAdapter {
  /** Currency rail this adapter settles. */
  readonly currency: Currency;

  /** Provision the account a user funds into (NUBAN for NGN; simulated ref for QAR). */
  createVirtualAccount(req: CreateVirtualAccountRequest): Promise<CreateVirtualAccountResult>;

  /** List banks for this rail (NGN), so a bank name can be resolved to its NIP code. */
  listBanks(): Promise<Bank[]>;

  /** Resolve the account holder's name before a payout. Never transfer without this. */
  nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryResult>;

  /** Verify a government ID (BVN/NIN) for KYC. Read-only identity check, never moves money. */
  verifyIdentity(req: IdentityVerificationRequest): Promise<IdentityVerificationResult>;

  /** Move money to an external bank account (NIP). OTP/PIN-gated by the caller. */
  bankTransfer(req: BankTransferRequest): Promise<TransferResult>;

  /** Fund an account (or detect an inbound funding event). */
  fund(accountRef: string, amount: number): Promise<TransferResult>;

  getBalance(accountRef: string): Promise<BalanceResult>;
}

// ── Merchant operations (merchant-global, not per-user) ──────────────────────
//
// Fetch Balances / Settlements / Disputes are operational views over the whole
// merchant account, not a user's wallet. They live behind their own interface so
// the per-user PartnerAdapter stays focused. Only rails with a real merchant
// account implement it (NGN → Flutterwave); surfaced in the admin dashboard.

export interface MerchantBalance {
  currency: string;
  /** Amount available to withdraw/settle. */
  availableBalance: number;
  /** Amount held in escrow / not yet available. */
  ledgerBalance: number;
}

export interface Settlement {
  id: string;
  status: string;
  currency: string;
  /** Net amount settled to the corporate bank account. */
  grossAmount: number;
  appFee: number;
  merchantFee: number;
  netAmount: number;
  /** ISO date the funds settle/settled. */
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
  /** Why the customer disputed the charge. */
  reason: string | null;
  customerEmail: string | null;
  /** Deadline to respond with evidence. */
  dueDate: string | null;
  createdAt: string | null;
  txRef: string | null;
}

export interface ListPage {
  /** 1-based page number. */
  page?: number;
  status?: string;
}

/** Optional capability implemented by rails with a real merchant account (NGN). */
export interface MerchantOpsAdapter {
  /** Merchant float across all settlement currencies. */
  getBalances(): Promise<MerchantBalance[]>;
  /** When funds settle from the processor into the corporate bank account. */
  listSettlements(page?: ListPage): Promise<Settlement[]>;
  getSettlement(id: string): Promise<Settlement>;
  /** Chargebacks/disputes raised by customers. */
  listDisputes(page?: ListPage): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;
}
