import type { Currency } from '@guildpay/shared';

/**
 * PartnerAdapter — the single boundary for all money movement.
 *
 * Flows NEVER touch the ledger or a payment provider directly; they call a
 * PartnerAdapter. One adapter per settlement rail:
 *   - QAR -> MockPartnerAdapter (internal double-entry Postgres ledger, no real money)
 *   - NGN -> FlutterwaveAdapter (Flutterwave sandbox — test money)
 *
 * Swapping a licensed partner later means implementing this interface, not
 * rewriting flows. The AI can PREPARE a transfer but only the OTP/PIN verifier
 * calls `completeTransfer` — see the `no-otp-no-money` gate.
 */
export interface TransferRequest {
  transactionId: string;
  fromAccountRef: string;
  recipientRef: string;
  recipientName?: string;
  amount: number;
  currency: Currency;
  purpose?: string;
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

export interface PartnerAdapter {
  /** Currency rail this adapter settles. */
  readonly currency: Currency;

  /** Fund a demo/sandbox account (funding is itself an OTP-gated action). */
  fund(accountRef: string, amount: number): Promise<TransferResult>;

  /** Move money. MUST only be invoked after OTP/PIN verification. */
  completeTransfer(req: TransferRequest): Promise<TransferResult>;

  getBalance(accountRef: string): Promise<BalanceResult>;
}
