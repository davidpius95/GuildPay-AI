import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** Time a half-finished transaction request waits for the missing detail. */
const TTL_SECONDS = 10 * 60;

/**
 * A transaction intent that is still gathering details across turns. Only the
 * slots the flows fill are tracked — this never holds a completed transaction
 * (that lives in the transactions table, PIN-gated). This is a deterministic
 * state-machine aid, NOT an LLM memory: it lets "send 5000" → "who to?" →
 * "0803..." complete without the model having to re-guess the amount.
 */
export interface PendingIntent {
  intent: 'p2p_transfer' | 'bank_transfer';
  amount: number | null;
  recipientRef: string | null;
  accountNumber: string | null;
  bankName: string | null;
}

@Injectable()
export class PendingIntentService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string): string {
    return `intent:${userId}`;
  }

  async get(userId: string): Promise<PendingIntent | null> {
    return this.redis.getJson<PendingIntent>(this.key(userId));
  }

  async set(userId: string, intent: PendingIntent): Promise<void> {
    await this.redis.setJson(this.key(userId), intent, TTL_SECONDS);
  }

  async clear(userId: string): Promise<void> {
    await this.redis.del(this.key(userId));
  }
}
