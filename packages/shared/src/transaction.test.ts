import { describe, expect, it } from 'vitest';
import { ExtractionSchema, IntentSchema, PaymentExtractionSchema } from './transaction';
import { CurrencySchema } from './currency';

describe('ExtractionSchema', () => {
  it('rejects a non-positive amount (never guess money)', () => {
    const result = ExtractionSchema.safeParse({
      intent: 'bank_transfer',
      amount: -5,
      recipientName: 'Acme',
      recipientRef: '0123456789',
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it('defaults currency to NGN (Nigeria-flagship) and accepts QAR', () => {
    const parsed = ExtractionSchema.parse({
      intent: 'airtime',
      amount: 1000,
      phoneNumber: '08030000000',
      network: 'mtn',
      confidence: 0.8,
    });
    expect(parsed.currency).toBe('NGN');
    expect(CurrencySchema.parse('QAR')).toBe('QAR');
  });

  it('classifies every supported money intent', () => {
    for (const intent of ['p2p_transfer', 'bank_transfer', 'airtime', 'bill_payment', 'savings']) {
      expect(IntentSchema.parse(intent)).toBe(intent);
    }
  });
});

describe('PaymentExtractionSchema (deprecated shim)', () => {
  it('still validates and defaults to NGN', () => {
    const parsed = PaymentExtractionSchema.parse({
      recipientName: 'Acme',
      recipientRef: 'GPA-1',
      amount: 100,
      purpose: 'invoice',
      confidence: 0.8,
    });
    expect(parsed.currency).toBe('NGN');
  });
});
