import { describe, expect, it } from 'vitest';
import { formatHistory, type HistoryLine } from './transaction-history.service';

const line = (over: Partial<HistoryLine>): HistoryLine => ({
  direction: 'debit',
  amount: '100.00',
  balance_after: '900.00',
  created_at: '2026-07-02T13:01:00Z',
  type: 'bank_transfer',
  recipient_name: 'John Doe',
  status: 'completed',
  ...over,
});

describe('formatHistory', () => {
  it('shows an empty state when there are no entries', () => {
    const out = formatHistory([], 'NGN');
    expect(out).toContain('No transactions yet');
  });

  it('renders debits and credits with direction and counterparty', () => {
    const out = formatHistory(
      [
        line({ direction: 'debit', amount: '100.00', recipient_name: 'John Doe', balance_after: '900.00' }),
        line({ direction: 'credit', amount: '50.00', recipient_name: 'Ada Lovelace', balance_after: '1000.00' }),
      ],
      'NGN',
    );
    expect(out).toContain('⬆️'); // debit / out
    expect(out).toContain('to John Doe');
    expect(out).toContain('⬇️'); // credit / in
    expect(out).toContain('from Ada Lovelace');
    // balance line uses the most-recent (first) entry's balance_after
    expect(out).toContain('Balance:');
  });

  it('labels an unnamed funding credit as Wallet funding', () => {
    const out = formatHistory([line({ direction: 'credit', type: 'fund', recipient_name: null })], 'NGN');
    expect(out).toContain('from Wallet funding');
  });

  it('formats money in the wallet currency', () => {
    const out = formatHistory([line({ amount: '2500.00' })], 'NGN');
    expect(out).toMatch(/₦\s?2,?500/);
  });
});
