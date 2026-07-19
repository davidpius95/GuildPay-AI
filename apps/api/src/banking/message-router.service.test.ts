import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '@guildpay/shared';
import { MessageRouter } from './message-router.service';
import { OrchestratorService } from './orchestrator.service';
import { ConversationService } from './conversation.service';
import { PendingIntentService } from './pending-intent.service';
import { RedisService } from '../redis/redis.service';
import { InMemoryRedis } from '../redis/in-memory-redis';
import type { AiService } from '../ai/ai.service';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UsersRepository } from '../database/users.repository';
import type { WalletsRepository } from '../database/wallets.repository';
import type { TransactionsRepository } from '../database/transactions.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { BeneficiariesRepository } from '../database/beneficiaries.repository';
import type { WalletService } from './wallet.service';
import type { TransferService } from './transfer.service';
import type { BankTransferService } from './bank-transfer.service';
import type { SnapToPayService } from './snap-to-pay.service';
import type { KycService } from './kyc.service';
import type { TransactionHistoryService } from './transaction-history.service';

const user = { id: 'u1', wa_phone: '2348000000001', full_name: 'Sender' };
const wallet = { id: 'w1', user_id: 'u1', currency: 'NGN', virtual_account_number: null, reference: 'GPA-NG-AAA' };

/** Build a router where the LLM/services are stubbed but conversation + pending
 *  intent use a real in-memory Redis, so multi-turn state is exercised for real. */
function harness(intentReplies: string[]) {
  const replies = [...intentReplies];
  const ai = {
    complete: vi.fn(async () => replies.shift() ?? '{"intent":"unknown","confidence":0}'),
    chat: vi.fn(async () => 'ok'),
  } as unknown as AiService;

  const redis = new RedisService(new InMemoryRedis());
  const conversation = new ConversationService(redis);
  const pendingIntent = new PendingIntentService(redis);
  const orchestrator = new OrchestratorService(ai);

  const channel = { send: vi.fn(async () => undefined) } as unknown as ChannelAdapter;
  const transfer = { start: vi.fn(async () => undefined) } as unknown as TransferService;
  const bankTransfer = { start: vi.fn(async () => undefined) } as unknown as BankTransferService;

  const walletSvc = { getBalance: vi.fn(async () => 10000) } as unknown as WalletService;
  const users = { findByWaPhone: vi.fn(async () => user) } as unknown as UsersRepository;
  const wallets = { findByUserId: vi.fn(async () => [wallet]) } as unknown as WalletsRepository;
  const txns = { findLatestByStatus: vi.fn(async () => null) } as unknown as TransactionsRepository;

  const router = new MessageRouter(
    channel,
    ai,
    users,
    wallets,
    txns,
    {} as AuditRepository,
    {} as BeneficiariesRepository,
    walletSvc,
    orchestrator,
    transfer,
    bankTransfer,
    {} as SnapToPayService,
    {} as KycService,
    {} as TransactionHistoryService,
    conversation,
    pendingIntent,
  );

  const say = (text: string) => router.handle({ waPhone: user.wa_phone, type: 'text', text } as InboundMessage);
  return { router, ai, channel, transfer, bankTransfer, pendingIntent, say };
}

describe('MessageRouter — multi-turn context', () => {
  it('completes "send 5000" → "who to?" → "0803..." without re-invoking the LLM for the bare reply', async () => {
    // Only the first turn parses via the LLM; the second is a bare recipient.
    const { ai, transfer, say } = harness([
      '{"intent":"p2p_transfer","amount":5000,"recipientRef":null,"confidence":0.9}',
    ]);

    await say('send 5000');
    expect(transfer.start).not.toHaveBeenCalled();
    expect(ai.complete).toHaveBeenCalledTimes(1);

    await say('08031234567');
    // The amount from turn 1 is preserved and the recipient is filled deterministically.
    expect(transfer.start).toHaveBeenCalledTimes(1);
    expect(transfer.start).toHaveBeenCalledWith(user, wallet, 5000, '08031234567');
    // No second LLM call — the bare number never went to the model.
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('gathers a bank transfer across turns: amount → account → bank', async () => {
    const { bankTransfer, say, ai } = harness([
      '{"intent":"bank_transfer","amount":2000,"accountNumber":null,"bankName":null,"confidence":0.9}',
    ]);

    await say('I want to send 2000 to a bank');
    await say('0690000031');
    expect(bankTransfer.start).not.toHaveBeenCalled();
    await say('GTBank');

    expect(bankTransfer.start).toHaveBeenCalledTimes(1);
    expect(bankTransfer.start).toHaveBeenCalledWith(user, wallet, 2000, '0690000031', 'GTBank');
    // Turns 2 and 3 were deterministic slot fills, not LLM parses.
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending intent on "cancel"', async () => {
    const { pendingIntent, transfer, say } = harness([
      '{"intent":"p2p_transfer","amount":5000,"recipientRef":null,"confidence":0.9}',
    ]);
    await say('send 5000');
    expect(await pendingIntent.get('u1')).not.toBeNull();
    await say('cancel');
    expect(await pendingIntent.get('u1')).toBeNull();
    expect(transfer.start).not.toHaveBeenCalled();
  });

  it('feeds recent conversation history into the intent parser', async () => {
    const { ai, say } = harness([
      '{"intent":"balance","confidence":0.9}',
      '{"intent":"support","confidence":0.5}',
    ]);
    await say('what is my balance');
    await say('and what can you do');
    // Second parse should have received the prior turns as leading context messages.
    const calls = (ai.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const secondCallMessages = calls[1]?.[0] as { role: string }[];
    expect(secondCallMessages.length).toBeGreaterThan(2); // system + history + user
    expect(secondCallMessages.some((m) => m.role === 'assistant')).toBe(true);
  });
});
