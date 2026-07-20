import { z } from 'zod';

/**
 * Supported settlement currencies.
 * - QAR: demo wallet on the internal double-entry ledger (MockPartnerAdapter).
 * - NGN: Naira accounts settled via Flutterwave (live rail).
 * Each currency maps to a PartnerAdapter implementation in apps/api.
 */
export const CurrencySchema = z.enum(['QAR', 'NGN']);
export type Currency = z.infer<typeof CurrencySchema>;

export const CURRENCY_META: Record<Currency, { symbol: string; minorUnitScale: number }> = {
  QAR: { symbol: 'QAR', minorUnitScale: 2 },
  NGN: { symbol: '₦', minorUnitScale: 2 },
};
