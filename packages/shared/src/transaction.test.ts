import { describe, expect, it } from 'vitest';
import { PaymentExtractionSchema } from './transaction';
import { CurrencySchema } from './currency';

describe('PaymentExtractionSchema', () => {
  it('rejects a non-positive amount (never guess money)', () => {
    const result = PaymentExtractionSchema.safeParse({
      recipientName: 'Acme',
      recipientRef: 'GPA-1',
      amount: -5,
      purpose: null,
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it('defaults currency to QAR and accepts NGN', () => {
    const parsed = PaymentExtractionSchema.parse({
      recipientName: 'Acme',
      recipientRef: 'GPA-1',
      amount: 100,
      purpose: 'invoice',
      confidence: 0.8,
    });
    expect(parsed.currency).toBe('QAR');
    expect(CurrencySchema.parse('NGN')).toBe('NGN');
  });
});
