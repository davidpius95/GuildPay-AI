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

export const TransactionChannelSchema = z.enum([
  'text',
  'voice',
  'image',
  'excel',
  'admin',
  'system',
]);
export type TransactionChannel = z.infer<typeof TransactionChannelSchema>;

/**
 * Validated output of an LLM payment extraction. Amounts are never guessed:
 * on validation failure the orchestrator retries once, then asks the user.
 */
export const PaymentExtractionSchema = z.object({
  recipientName: z.string().min(1).nullable(),
  recipientRef: z.string().min(1).nullable(),
  amount: z.number().positive().nullable(),
  currency: CurrencySchema.default('QAR'),
  purpose: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type PaymentExtraction = z.infer<typeof PaymentExtractionSchema>;
