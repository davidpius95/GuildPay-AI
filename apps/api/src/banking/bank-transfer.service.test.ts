import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BankTransferService, resolveBank } from './bank-transfer.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UsersRepository, UserRow } from '../database/users.repository';
import type { WalletRow } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from './wallet.service';
import { InsufficientFundsError } from './wallet.service';
import type { OtpService } from './otp.service';
import type { PartnerService } from '../partner/partner.service';

const wallet = {
  id: 'w1',
  user_id: 'u1',
  reference: 'GPA-NG-AAA',
  currency: 'NGN',
  market: 'NG',
  balance: '10000',
  txn_limit: '50000',
} as unknown as WalletRow;
const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Sender' } as unknown as UserRow;

const banks = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'GTBank' },
];

function make(opts: { transferStatus?: 'completed' | 'pending' | 'failed'; debitThrows?: boolean } = {}) {
  const channel = { send: vi.fn(async () => undefined) } as unknown as ChannelAdapter;
  const users = { findById: vi.fn(async () => user) } as unknown as UsersRepository;
  const txns = {
    create: vi.fn(async () => ({ id: 'txn1' })),
    findById: vi.fn(async () => ({
      id: 'txn1',
      type: 'bank_transfer',
      status: 'pending_otp',
      amount: '2000',
      currency: 'NGN',
      recipient_ref: '0690000031',
      recipient_name: 'Ada Bank',
      bank_code: '044',
    })),
    setStatus: vi.fn(async () => undefined),
  } as unknown as TransactionsRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditRepository;
  const wallet$ = {
    debit: opts.debitThrows
      ? vi.fn(async () => {
          throw new InsufficientFundsError();
        })
      : vi.fn(async () => '8000'),
    credit: vi.fn(async () => '10000'),
    getBalance: vi.fn(async () => '8000'),
  } as unknown as WalletService;
  const otp = { issue: vi.fn(async () => '123456'), verify: vi.fn() } as unknown as OtpService;
  const bankTransfer = vi.fn(async () => ({ providerRef: 'flw1', status: opts.transferStatus ?? 'completed' }));
  const adapter = {
    listBanks: vi.fn(async () => banks),
    nameEnquiry: vi.fn(async () => ({ accountNumber: '0690000031', bankCode: '044', accountName: 'Ada Bank' })),
    bankTransfer,
  };
  const partners = { forCurrency: vi.fn(() => adapter) } as unknown as PartnerService;

  const svc = new BankTransferService(channel, users, txns, audit, wallet$, otp, partners);
  return { svc, channel, txns, wallet: wallet$, otp, bankTransfer, adapter };
}

describe('resolveBank', () => {
  it('matches exact and unique-partial names, rejects ambiguous/unknown', () => {
    expect(resolveBank(banks, 'GTBank')?.code).toBe('058');
    expect(resolveBank(banks, 'access')?.code).toBe('044');
    expect(resolveBank(banks, 'bank')).toBeNull(); // ambiguous (both contain "bank")
    expect(resolveBank(banks, 'zenith')).toBeNull();
  });
});

describe('BankTransferService — no-otp-no-money gate', () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    h = make();
  });

  it('start() does name enquiry and creates a pending confirmation, moving NO money', async () => {
    await h.svc.start(user, wallet, 2000, '0690000031', 'Access Bank');
    expect(h.adapter.nameEnquiry).toHaveBeenCalledWith('0690000031', '044');
    expect(h.txns.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bank_transfer', status: 'pending_confirmation', bankCode: '044' }),
    );
    expect(h.wallet.debit).not.toHaveBeenCalled();
    expect(h.bankTransfer).not.toHaveBeenCalled();
  });

  it('an unknown bank is rejected before any money movement', async () => {
    await h.svc.start(user, wallet, 2000, '0690000031', 'Zenith');
    expect(h.txns.create).not.toHaveBeenCalled();
    expect(h.bankTransfer).not.toHaveBeenCalled();
  });

  it('a WRONG code moves NO money', async () => {
    (h.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: 'wrong_code' });
    await h.svc.submitOtp(user, wallet, '000000');
    expect(h.wallet.debit).not.toHaveBeenCalled();
    expect(h.bankTransfer).not.toHaveBeenCalled();
  });

  it('a VALID code debits then pays out and completes', async () => {
    (h.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, transactionId: 'txn1' });
    await h.svc.submitOtp(user, wallet, '123456');
    expect(h.wallet.debit).toHaveBeenCalledWith('w1', 2000, 'txn1');
    expect(h.bankTransfer).toHaveBeenCalledOnce();
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'completed');
  });

  it('reverses the debit when the payout fails', async () => {
    const f = make({ transferStatus: 'failed' });
    (f.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, transactionId: 'txn1' });
    await f.svc.submitOtp(user, wallet, '123456');
    expect(f.wallet.debit).toHaveBeenCalledOnce();
    expect(f.wallet.credit).toHaveBeenCalledWith('w1', 2000, 'txn1'); // refunded
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'failed');
  });

  it('insufficient funds fails without calling the payout', async () => {
    const f = make({ debitThrows: true });
    (f.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, transactionId: 'txn1' });
    await f.svc.submitOtp(user, wallet, '123456');
    expect(f.bankTransfer).not.toHaveBeenCalled();
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'failed');
  });
});
