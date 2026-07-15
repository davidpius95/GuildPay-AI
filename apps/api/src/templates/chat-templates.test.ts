import { describe, expect, it } from 'vitest';
import { card, disputeCard, kycResultCard, maskId, settlementCard } from './chat-templates';
import type { Dispute, IdentityVerificationResult, Settlement } from '../partner/partner-adapter';

describe('chat-templates', () => {
  describe('maskId — never leaks a full government id', () => {
    it('shows only the last 4 digits', () => {
      expect(maskId('22345678901')).toBe('•••••••8901');
      expect(maskId('12345678901')).not.toContain('1234567');
    });
    it('handles short/empty input safely', () => {
      expect(maskId('123')).toBe('••••');
      expect(maskId('')).toBe('—');
      expect(maskId(null)).toBe('—');
    });
  });

  it('card omits rows with empty/undefined values', () => {
    const out = card({ title: 'T', rows: [{ label: 'A', value: 'x' }, { label: 'B', value: null }] });
    expect(out).toContain('A: x');
    expect(out).not.toContain('B:');
  });

  describe('kycResultCard', () => {
    const base = (over: Partial<IdentityVerificationResult>): IdentityVerificationResult => ({
      type: 'bvn',
      status: 'verified',
      ...over,
    });

    it('masks the id and never prints it in full', () => {
      const out = kycResultCard(base({ status: 'verified', name: 'Ada Obi' }), '22345678901');
      expect(out).toContain('•••••••8901');
      expect(out).not.toContain('22345678901');
      expect(out).toContain('Ada Obi');
    });

    it('renders a pending consent card with the link', () => {
      const out = kycResultCard(base({ status: 'pending', consentUrl: 'https://flw/consent' }), '22345678901');
      expect(out).toContain('in progress');
      expect(out).toContain('https://flw/consent');
    });

    it('renders a failure reason without the raw id', () => {
      const out = kycResultCard(base({ status: 'failed', message: 'Details did not match' }), '22345678901');
      expect(out).toContain('Details did not match');
      expect(out).not.toContain('22345678901');
    });
  });

  it('settlementCard shows net amount and masks the destination account', () => {
    const s: Settlement = {
      id: '551', status: 'completed', currency: 'NGN', grossAmount: 10000, appFee: 100,
      merchantFee: 50, netAmount: 9850, dueDate: null, createdAt: null,
      bankName: 'GTBank', accountNumber: '0690000031',
    };
    const out = settlementCard(s);
    expect(out).toContain('Settlement 551');
    expect(out).toContain('₦9,850.00');
    expect(out).toContain('••••0031');
    expect(out).not.toContain('0690000031');
  });

  it('disputeCard flags pending disputes as needing action', () => {
    const d: Dispute = {
      id: '77', status: 'pending', currency: 'NGN', amount: 5000, reason: 'fraud',
      customerEmail: 'a@b.com', dueDate: null, createdAt: null, txRef: 'tx_1',
    };
    const out = disputeCard(d);
    expect(out).toContain('Dispute 77');
    expect(out).toContain('Action needed');
  });
});
