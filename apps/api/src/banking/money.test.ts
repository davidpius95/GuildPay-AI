import { describe, expect, it } from 'vitest';
import { formatMoney, phoneCandidates } from './money';

describe('formatMoney', () => {
  it('formats NGN and QAR with thousands + 2dp', () => {
    expect(formatMoney('NGN', '2000')).toBe('₦2,000.00');
    expect(formatMoney('NGN', 1234567.5)).toBe('₦1,234,567.50');
    expect(formatMoney('QAR', '1500')).toBe('QAR1,500.00');
  });
});

describe('phoneCandidates', () => {
  it('maps a Nigerian local number to its international form', () => {
    expect(phoneCandidates('08031234567', 'NG')).toContain('2348031234567');
  });
  it('keeps an already-international number', () => {
    expect(phoneCandidates('+2348031234567', 'NG')).toContain('2348031234567');
  });
  it('uses 974 for Qatar', () => {
    expect(phoneCandidates('033123456', 'QA')).toContain('97433123456');
  });
});
