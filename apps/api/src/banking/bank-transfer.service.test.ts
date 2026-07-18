import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BankTransferService, resolveBank, payoutReason } from './bank-transfer.service';
import { PinService } from './pin.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UsersRepository, UserRow } from '../database/users.repository';
import type { WalletRow } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { WalletService } from './wallet.service';
import { InsufficientFundsError } from './wallet.service';
import type { PartnerService } from '../partner/partner.service';
import type { WhatsappFlowService } from '../channel/whatsapp-flow.service';

const pins = new PinService(); // real crypto — the gate under test
const PIN_HASH = pins.hash('1234');

const wallet = {
  id: 'w1',
  user_id: 'u1',
  reference: 'GPA-NG-AAA',
  currency: 'NGN',
  market: 'NG',
  balance: '10000',
  txn_limit: '50000',
} as unknown as WalletRow;
const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Sender', pin_hash: PIN_HASH } as unknown as UserRow;

const banks = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'GTBank' },
];

const pendingTxn = {
  id: 'txn1',
  type: 'bank_transfer',
  status: 'pending_otp',
  amount: '2000',
  currency: 'NGN',
  recipient_ref: '0690000031',
  recipient_name: 'Ada Bank',
  bank_code: '044',
};

function make(
  opts: { transferStatus?: 'completed' | 'pending' | 'failed'; debitThrows?: boolean; failCount?: number } = {},
) {
  const channel = { send: vi.fn(async () => undefined) } as unknown as ChannelAdapter;
  const users = {
    findById: vi.fn(async () => user),
    update: vi.fn(async () => user),
  } as unknown as UsersRepository;
  const txns = {
    create: vi.fn(async () => ({ id: 'txn1' })),
    findById: vi.fn(async () => pendingTxn),
    findLatestByStatus: vi.fn(async () => pendingTxn),
    setStatus: vi.fn(async () => undefined),
  } as unknown as TransactionsRepository;
  const audit = {
    record: vi.fn(async () => undefined),
    countByEntityAction: vi.fn(async () => opts.failCount ?? 1),
  } as unknown as AuditRepository;
  const wallet$ = {
    debit: opts.debitThrows
      ? vi.fn(async () => {
          throw new InsufficientFundsError();
        })
      : vi.fn(async () => '8000'),
    credit: vi.fn(async () => '10000'),
    getBalance: vi.fn(async () => '8000'),
  } as unknown as WalletService;
  const bankTransfer = vi.fn(async () => ({ providerRef: 'flw1', status: opts.transferStatus ?? 'completed' }));
  const adapter = {
    listBanks: vi.fn(async () => banks),
    nameEnquiry: vi.fn(async () => ({ accountNumber: '0690000031', bankCode: '044', accountName: 'Ada Bank' })),
    bankTransfer,
  };
  const partners = { forCurrency: vi.fn(() => adapter) } as unknown as PartnerService;
  const receipts = { render: vi.fn(() => Buffer.from('png')) } as unknown as import('./receipt.service').ReceiptService;

  const flows = { isEnabled: () => false } as unknown as WhatsappFlowService;
  const svc = new BankTransferService(channel, users, txns, audit, wallet$, pins, partners, receipts, flows);
  return { svc, channel, txns, wallet: wallet$, users, audit, bankTransfer, adapter };
}

describe('resolveBank', () => {
  it('matches exact and unique-partial names, rejects ambiguous/unknown', () => {
    expect(resolveBank(banks, 'GTBank')?.code).toBe('058');
    expect(resolveBank(banks, 'access')?.code).toBe('044');
    expect(resolveBank(banks, 'bank')).toBeNull(); // ambiguous (both contain "bank")
    expect(resolveBank(banks, 'zenith')).toBeNull();
  });
});

describe('payoutReason', () => {
  it('strips the internal wrapper and surfaces the provider message', () => {
    const r = payoutReason('Flutterwave POST /transfers failed: merchant is not enabled to make transfers.');
    expect(r).toContain('merchant is not enabled to make transfers');
    expect(r).not.toContain('Flutterwave POST');
    expect(r).toContain('Business Preferences'); // hint for this gate
  });
  it('passes through an unknown reason unchanged', () => {
    expect(payoutReason('some other error')).toBe('some other error');
  });
});

describe('BankTransferService — no-pin-no-money gate', () => {
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

  it('a WRONG PIN moves NO money and is audited', async () => {
    await h.svc.submitPin(user, wallet, '0000');
    expect(h.wallet.debit).not.toHaveBeenCalled();
    expect(h.bankTransfer).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'pin_failed' }));
  });

  it('3 wrong attempts cancel the transaction', async () => {
    const f = make({ failCount: 3 });
    await f.svc.submitPin(user, wallet, '0000');
    expect(f.wallet.debit).not.toHaveBeenCalled();
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'cancelled');
  });

  it('a user with NO PIN sets it first — setting the PIN moves NO money', async () => {
    const noPinUser = { ...user, pin_hash: null } as unknown as UserRow;
    await h.svc.submitPin(noPinUser, wallet, '4821');
    expect(h.users.update).toHaveBeenCalledWith('u1', expect.objectContaining({ pin_hash: expect.any(String) }));
    expect(h.wallet.debit).not.toHaveBeenCalled();
  });

  it('the CORRECT PIN debits then pays out and completes', async () => {
    await h.svc.submitPin(user, wallet, '1234');
    expect(h.wallet.debit).toHaveBeenCalledWith('w1', 2000, 'txn1', 'NIP Transfer Hold', 'txn1');
    expect(h.bankTransfer).toHaveBeenCalledOnce();
    expect(h.txns.setStatus).toHaveBeenCalledWith('txn1', 'completed');
  });

  it('reverses the debit when the payout fails', async () => {
    const f = make({ transferStatus: 'failed' });
    await f.svc.submitPin(user, wallet, '1234');
    expect(f.wallet.debit).toHaveBeenCalledOnce();
    expect(f.wallet.credit).toHaveBeenCalledWith('w1', 2000, 'txn1', 'NIP Transfer Refund', 'txn1'); // refunded
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'failed');
  });

  it('insufficient funds fails without calling the payout', async () => {
    const f = make({ debitThrows: true });
    await f.svc.submitPin(user, wallet, '1234');
    expect(f.bankTransfer).not.toHaveBeenCalled();
    expect(f.txns.setStatus).toHaveBeenCalledWith('txn1', 'failed');
  });
});
