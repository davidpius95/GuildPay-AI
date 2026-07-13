import type { Currency, NameEnquiryResult } from '@guildpay/shared';

/**
 * PartnerAdapter — the single boundary for external settlement + account services.
 *
 * Capability modules never touch a provider SDK or the ledger directly; they use
 * `WalletService` (internal balances) + a PartnerAdapter (external rail):
 *   - NGN → FlutterwavePartnerAdapter (Flutterwave sandbox — test money)
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

export interface PartnerAdapter {
  /** Currency rail this adapter settles. */
  readonly currency: Currency;

  /** Provision the account a user funds into (NUBAN for NGN; simulated ref for QAR). */
  createVirtualAccount(req: CreateVirtualAccountRequest): Promise<CreateVirtualAccountResult>;

  /** List banks for this rail (NGN), so a bank name can be resolved to its NIP code. */
  listBanks(): Promise<Bank[]>;

  /** Resolve the account holder's name before a payout. Never transfer without this. */
  nameEnquiry(accountNumber: string, bankCode: string): Promise<NameEnquiryResult>;

  /** Move money to an external bank account (NIP). OTP/PIN-gated by the caller. */
  bankTransfer(req: BankTransferRequest): Promise<TransferResult>;

  /** Fund a demo/sandbox account (or detect an inbound funding event). */
  fund(accountRef: string, amount: number): Promise<TransferResult>;

  getBalance(accountRef: string): Promise<BalanceResult>;
}
