import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FlutterwaveV4Controller } from './flutterwave-v4.controller';
import type { ConfigService } from '@nestjs/config';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { WalletsRepository } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { UsersRepository } from '../database/users.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from '../banking/wallet.service';
import { WalletFundingService } from '../banking/wallet-funding.service';

const SECRET = 'v4-secret';

function harness(over: { duplicate?: boolean; wallet?: unknown } = {}) {
  const credit = vi.fn(async () => '7000');
  const create = vi.fn(async () => ({ id: 'txn9' }));
  const send = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);

  const wallet =
    'wallet' in over ? over.wallet : { id: 'w1', user_id: 'u1', reference: 'GPA-NG-XYZ', currency: 'NGN' };

  const channel = { send } as unknown as ChannelAdapter;
  const txns = {
    findByProviderRef: vi.fn(async () => (over.duplicate ? { id: 'existing' } : null)),
    create,
  } as unknown as TransactionsRepository;
  const users = { findById: vi.fn(async () => ({ wa_phone: '2348030000000' })) } as unknown as UsersRepository;
  const audit = { record } as unknown as AuditRepository;
  const walletSvc = { credit } as unknown as WalletService;
  const funding = new WalletFundingService(channel, txns, users, audit, walletSvc);

  const controller = new FlutterwaveV4Controller(
    { get: vi.fn(() => SECRET) } as unknown as ConfigService,
    { findByVirtualAccountNumber: vi.fn(async () => wallet) } as unknown as WalletsRepository,
    audit,
    funding,
  );
  return { controller, credit, send, record };
}

const creditEvent = {
  type: 'virtualaccount.credited',
  data: { id: 'chg_1', status: 'succeeded', amount: 7000, currency: 'NGN', account_number: '9911223344' },
};

function signedReq(body: unknown, sig?: string): { rawBody: Buffer; headers: Record<string, string> } {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = sig ?? createHmac('sha256', SECRET).update(rawBody).digest('hex');
  return { rawBody, headers: { 'flutterwave-signature': signature } };
}

describe('FlutterwaveV4Controller — funding', () => {
  it('rejects a bad signature', () => {
    const h = harness();
    const req = signedReq(creditEvent, 'not-the-signature');
    expect(() => h.controller.receive(req as never, creditEvent)).toThrow();
  });

  it('accepts a valid signature', () => {
    const h = harness();
    const req = signedReq(creditEvent);
    expect(h.controller.receive(req as never, creditEvent)).toEqual({ status: 'ok' });
  });

  it('credits the wallet matched by account number, once', async () => {
    const h = harness();
    await h.controller['process'](creditEvent);
    expect(h.credit).toHaveBeenCalledWith('w1', 7000, 'txn9', 'Wallet Funding via Flutterwave', 'chg_1');
    expect(h.send).toHaveBeenCalledOnce();
  });

  it('is idempotent — a duplicate providerRef does not credit again', async () => {
    const h = harness({ duplicate: true });
    await h.controller['process'](creditEvent);
    expect(h.credit).not.toHaveBeenCalled();
  });

  it('records unmatched funding when no wallet has that account number', async () => {
    const h = harness({ wallet: null });
    await h.controller['process'](creditEvent);
    expect(h.credit).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'funding_unmatched' }));
  });
});
