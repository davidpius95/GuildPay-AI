import { Injectable } from '@nestjs/common';
import type { ChatMessage } from '../ai/ai-provider';
import { RedisService } from '../redis/redis.service';

/** How many recent turns to keep and replay as context. */
const MAX_TURNS = 8;
/** A WhatsApp "session" — context expires after this idle window. */
const TTL_SECONDS = 30 * 60;
/** Guard against pathological entries bloating the context window. */
const MAX_CONTENT_CHARS = 1000;

/** Compact on-wire shape: r=role (u|a), c=content. */
interface StoredTurn {
  r: 'u' | 'a';
  c: string;
}

/**
 * Short-term conversational memory. Records the last few user⇄assistant turns per
 * user in Redis so the intent parser and the free-chat fallback can see the flow
 * of the conversation — what was just asked, what the assistant replied — instead
 * of treating every message in isolation.
 */
@Injectable()
export class ConversationService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string): string {
    return `conv:${userId}`;
  }

  /** Record one turn. Empty/whitespace content is ignored. */
  async record(userId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    const text = content.trim();
    if (!text) return;
    const turn: StoredTurn = { r: role === 'user' ? 'u' : 'a', c: text.slice(0, MAX_CONTENT_CHARS) };
    await this.redis.pushCapped(this.key(userId), JSON.stringify(turn), MAX_TURNS, TTL_SECONDS);
  }

  /** Recent turns oldest→newest, as ChatMessages ready to prepend to an LLM call. */
  async history(userId: string): Promise<ChatMessage[]> {
    const raw = await this.redis.list(this.key(userId));
    const out: ChatMessage[] = [];
    for (const item of raw) {
      try {
        const t = JSON.parse(item) as StoredTurn;
        out.push({ role: t.r === 'u' ? 'user' : 'assistant', content: t.c });
      } catch {
        // Skip any malformed entry rather than fail the whole read.
      }
    }
    return out;
  }
}
