import { z } from 'zod';
import { CurrencySchema } from './currency';

export const TransactionStatusSchema = z.enum([
  'draft',
  'pending_confirmation',
  'pending_otp',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

/** How the user expressed the request. */
export const TransactionChannelSchema = z.enum(['text', 'voice', 'image', 'admin', 'system']);
export type TransactionChannel = z.infer<typeof TransactionChannelSchema>;

/**
 * The money actions a user can drive by conversation. One capability module per type.
 * The AI classifies free-form input into exactly one of these (or asks to clarify).
 */
export const IntentSchema = z.enum([
  'fund',
  'balance',
  'history',
  'p2p_transfer', // send to another GuildPay user
  'bank_transfer', // send to any bank account (NIP payout) — NGN
  'airtime', // NGN
  'data', // NGN
  'bill_payment', // electricity / cable / betting — NGN
  'savings', // create/fund/withdraw a savings goal
  'request_money',
  'spending_insights',
  'support', // not a money action; FAQ / help
  'unknown', // could not classify — trigger clarification
]);
export type Intent = z.infer<typeof IntentSchema>;

/** Transaction type persisted in the ledger (money actions only). */
export const TransactionTypeSchema = z.enum([
  'funding',
  'p2p_transfer',
  'bank_transfer',
  'airtime',
  'data',
  'bill_payment',
  'savings_deposit',
  'savings_withdrawal',
  'refund',
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

/**
 * Validated output of an LLM extraction. Nothing is ever guessed: on validation
 * failure the orchestrator retries once, then asks the user. Fields are nullable
 * because a single natural-language message rarely supplies all of them — the
 * capability module prompts for whatever is missing before confirmation.
 */
export const ExtractionSchema = z.object({
  intent: IntentSchema,
  currency: CurrencySchema.default('NGN'),
  amount: z.number().positive().nullable().default(null),
  // recipient (P2P or bank transfer)
  recipientName: z.string().min(1).nullable().default(null),
  recipientRef: z.string().min(1).nullable().default(null), // GuildPay ref, phone, or bank account no.
  bankName: z.string().min(1).nullable().default(null),
  bankCode: z.string().min(1).nullable().default(null),
  // airtime / data / bills
  phoneNumber: z.string().min(1).nullable().default(null),
  network: z.string().min(1).nullable().default(null), // mtn | glo | airtel | 9mobile
  billerId: z.string().min(1).nullable().default(null),
  customerId: z.string().min(1).nullable().default(null), // meter / smartcard / betting id
  purpose: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * @deprecated Kept for back-compat with early scaffold tests. Use ExtractionSchema.
 * A payment-only slice of the extraction shape.
 */
export const PaymentExtractionSchema = z.object({
  recipientName: z.string().min(1).nullable(),
  recipientRef: z.string().min(1).nullable(),
  amount: z.number().positive().nullable(),
  currency: CurrencySchema.default('NGN'),
  purpose: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type PaymentExtraction = z.infer<typeof PaymentExtractionSchema>;
