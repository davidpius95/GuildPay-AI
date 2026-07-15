import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TransferService } from './transfer.service';
import { PinService } from './pin.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UsersRepository, UserRow } from '../database/users.repository';
import type { WalletsRepository, WalletRow } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from './wallet.service';
import type { ReceiptService } from './receipt.service';

const pins = new PinService(); // real crypto — the gate under test
const PIN_HASH = pins.hash('1234');

const sender = { id: 'w1', user_id: 'u1', reference: 'GPA-NG-AAA', currency: 'NGN', market: 'NG', balance: '10000', txn_limit: '50000' } as unknown as WalletRow;
const recipientWallet = { id: 'w2', user_id: 'u2', reference: 'GPA-NG-BBB', currency: 'NGN', market: 'NG', balance: '0' } as unknown as WalletRow;
const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Sender', pin_hash: PIN_HASH } as unknown as UserRow;
const recipientUser = { id: 'u2', wa_phone: '2348000000002', full_name: 'Ada' } as unknown as UserRow;

const pendingTxn = {
  id: 'txn1',
  type: 'p2p_transfer',
  status: 'pending_otp',
  amount: '2000',
  currency: 'NGN',
  recipient_ref: 'GPA-NG-BBB',
  recipient_name: 'Ada',
};

function make(failCount = 1) {
  const channel = { send: vi.fn(async () => undefined) } as unknown as ChannelAdapter;
  const users = {
    findById: vi.fn(async () => recipientUser),
    findByAnyWaPhone: vi.fn(async () => recipientUser),
    update: vi.fn(async () => user),
  } as unknown as UsersRepository;
  const wallets = {
    findByUserId: vi.fn(async () => [recipientWallet]),
    findByReference: vi.fn(async () => recipientWallet),
  } as unknown as WalletsRepository;
  const txns = {
    create: vi.fn(async () => ({ id: 'txn1' })),
    findById: vi.fn(async () => pendingTxn),
    findLatestByStatus: vi.fn(async () => pendingTxn),
    setStatus: vi.fn(async () => undefined),
  } as unknown as TransactionsRepository;
  const audit = {
    record: vi.fn(async () => undefined),
    countByEntityAction: vi.fn(async () => failCount),
  } as unknown as AuditRepository;
  const wallet = {
    transfer: vi.fn(async () => ({ fromBalance: '8000', toBalance: '2000' })),
  } as unknown as WalletService;
  const receipts = { render: vi.fn(() => Buffer.from('png')) } as unknown as ReceiptService;

  const svc = new TransferService(channel, users, wallets, txns, audit, wallet, pins, receipts);
  return { svc, channel, txns, wallet, users, audit };
}

describe('TransferService — no-pin-no-money gate', () => {
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

  it('confirm() asks for the PIN and moves NO money', async () => {
    await h.svc.confirm(user, { id: 'txn1' } as never);
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'pending_otp');
    expect(h.wallet.transfer).not.toHaveBeenCalled();
  });

  it('a WRONG PIN moves NO money and is audited', async () => {
    await h.svc.submitPin(user, sender, '0000');
    expect(h.wallet.transfer).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'pin_failed' }));
  });

  it('3 wrong attempts cancel the transaction', async () => {
    const f = make(3); // audit reports this was the 3rd failure
    await f.svc.submitPin(user, sender, '0000');
    expect(f.wallet.transfer).not.toHaveBeenCalled();
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'cancelled');
  });

  it('a user with NO PIN sets it first — setting the PIN moves NO money', async () => {
    const noPinUser = { ...user, pin_hash: null } as unknown as UserRow;
    await h.svc.submitPin(noPinUser, sender, '4821');
    expect(h.users.update).toHaveBeenCalledWith('u1', expect.objectContaining({ pin_hash: expect.any(String) }));
    expect(h.wallet.transfer).not.toHaveBeenCalled(); // must re-enter to approve
  });

  it('only the CORRECT PIN moves money and completes the transaction', async () => {
    await h.svc.submitPin(user, sender, '1234');
    expect(h.wallet.transfer).toHaveBeenCalledOnce();
    expect(h.wallet.transfer).toHaveBeenCalledWith('w1', 'w2', 2000, 'txn1');
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'completed');
  });
});
