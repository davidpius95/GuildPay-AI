import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TransferService } from './transfer.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UsersRepository, UserRow } from '../database/users.repository';
import type { WalletsRepository, WalletRow } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from './wallet.service';
import type { OtpService } from './otp.service';

const sender = { id: 'w1', user_id: 'u1', reference: 'GPA-NG-AAA', currency: 'NGN', market: 'NG', balance: '10000', txn_limit: '50000' } as unknown as WalletRow;
const recipientWallet = { id: 'w2', user_id: 'u2', reference: 'GPA-NG-BBB', currency: 'NGN', market: 'NG', balance: '0' } as unknown as WalletRow;
const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Sender' } as unknown as UserRow;
const recipientUser = { id: 'u2', wa_phone: '2348000000002', full_name: 'Ada' } as unknown as UserRow;

function make() {
  const channel = { send: vi.fn(async () => undefined) } as unknown as ChannelAdapter;
  const users = {
    findById: vi.fn(async () => recipientUser),
    findByAnyWaPhone: vi.fn(async () => recipientUser),
  } as unknown as UsersRepository;
  const wallets = {
    findByUserId: vi.fn(async () => [recipientWallet]),
    findByReference: vi.fn(async () => recipientWallet),
  } as unknown as WalletsRepository;
  const txns = {
    create: vi.fn(async () => ({ id: 'txn1' })),
    findById: vi.fn(async () => ({
      id: 'txn1',
      status: 'pending_otp',
      amount: '2000',
      currency: 'NGN',
      recipient_ref: 'GPA-NG-BBB',
      recipient_name: 'Ada',
    })),
    setStatus: vi.fn(async () => undefined),
  } as unknown as TransactionsRepository;
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditRepository;
  const wallet = {
    transfer: vi.fn(async () => ({ fromBalance: '8000', toBalance: '2000' })),
  } as unknown as WalletService;
  const otp = { issue: vi.fn(async () => '123456'), verify: vi.fn() } as unknown as OtpService;

  const svc = new TransferService(channel, users, wallets, txns, audit, wallet, otp);
  return { svc, channel, txns, wallet, otp };
}

describe('TransferService — no-otp-no-money gate', () => {
  let h: ReturnType<typeof make>;
  beforeEach(() => {
    h = make();
  });

  it('start() creates a pending confirmation and moves NO money', async () => {
    await h.svc.start(user, sender, 2000, '08000000002');
    expect(h.txns.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_confirmation', type: 'p2p_transfer' }),
    );
    expect(h.wallet.transfer).not.toHaveBeenCalled();
  });

  it('confirm() issues an OTP and moves NO money', async () => {
    await h.svc.confirm(user, { id: 'txn1' } as never);
    expect(h.otp.issue).toHaveBeenCalledOnce();
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'pending_otp');
    expect(h.wallet.transfer).not.toHaveBeenCalled();
  });

  it('a WRONG code moves NO money', async () => {
    (h.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, reason: 'wrong_code' });
    await h.svc.submitOtp(user, sender, '000000');
    expect(h.wallet.transfer).not.toHaveBeenCalled();
  });

  it('only a VALID code moves money and completes the transaction', async () => {
    (h.otp.verify as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, transactionId: 'txn1' });
    await h.svc.submitOtp(user, sender, '123456');
    expect(h.wallet.transfer).toHaveBeenCalledOnce();
    expect(h.wallet.transfer).toHaveBeenCalledWith('w1', 'w2', 2000, 'txn1');
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'completed');
  });
});
