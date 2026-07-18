import { describe, expect, it, vi } from 'vitest';
import { FlutterwaveController } from './flutterwave.controller';
import type { ConfigService } from '@nestjs/config';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { FlutterwavePartnerAdapter } from '../partner/flutterwave-partner.adapter';
import type { WalletsRepository } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { UsersRepository } from '../database/users.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from '../banking/wallet.service';

function harness(over: { duplicate?: boolean; status?: string; wallet?: unknown } = {}) {
  const credit = vi.fn(async () => '5000');
  const create = vi.fn(async () => ({ id: 'txn1' }));
  const send = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const verifyTransaction = vi.fn(async () => ({
    status: over.status ?? 'successful',
    amount: 5000,
    currency: 'NGN',
    txRef: 'GPA-NG-ABC123',
  }));

  const wallet =
    'wallet' in over
      ? over.wallet
      : { id: 'w1', user_id: 'u1', reference: 'GPA-NG-ABC123', currency: 'NGN' };

  const controller = new FlutterwaveController(
    { get: vi.fn(() => 'secret-hash') } as unknown as ConfigService,
    { send } as unknown as ChannelAdapter,
    { verifyTransaction } as unknown as FlutterwavePartnerAdapter,
    { findByReference: vi.fn(async () => wallet) } as unknown as WalletsRepository,
    {
      findByProviderRef: vi.fn(async () => (over.duplicate ? { id: 'existing' } : null)),
      create,
    } as unknown as TransactionsRepository,
    { findById: vi.fn(async () => ({ wa_phone: '2348030000000' })) } as unknown as UsersRepository,
    { record } as unknown as AuditRepository,
    { credit } as unknown as WalletService,
  );

  return { controller, credit, create, send, record, verifyTransaction };
}

const charge = {
  event: 'charge.completed',
  data: { id: 99, flw_ref: 'FLW-REF-1', tx_ref: 'GPA-NG-ABC123', amount: 5000, currency: 'NGN', status: 'successful' },
};

describe('FlutterwaveController — funding', () => {
  it('rejects a bad verif-hash', () => {
    const h = harness();
    expect(() => h.controller.receive('wrong', charge)).toThrow();
  });

  it('credits the matched wallet once, verified at source', async () => {
    const h = harness();
    await h.controller['process'](charge);
    expect(h.verifyTransaction).toHaveBeenCalledWith(99);
    expect(h.credit).toHaveBeenCalledWith('w1', 5000, 'txn1', 'Wallet Funding via Flutterwave', 'FLW-REF-1');
    expect(h.send).toHaveBeenCalledOnce(); // user notified
  });

  it('is idempotent — a duplicate flw_ref does not credit again', async () => {
    const h = harness({ duplicate: true });
    await h.controller['process'](charge);
    expect(h.credit).not.toHaveBeenCalled();
  });

  it('does not credit an unsuccessful charge', async () => {
    const h = harness({ status: 'failed' });
    await h.controller['process'](charge);
    expect(h.credit).not.toHaveBeenCalled();
  });

  it('records unmatched funding instead of crediting when no wallet matches', async () => {
    const h = harness({ wallet: null });
    await h.controller['process'](charge);
    expect(h.credit).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'funding_unmatched' }),
    );
  });
});
