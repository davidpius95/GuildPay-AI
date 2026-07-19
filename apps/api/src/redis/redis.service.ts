import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from './redis.constants';
import type { RedisLike } from './in-memory-redis';

/**
 * Thin, typed wrapper over the shared Redis client. Domain services
 * (ConversationService, PendingIntentService) use these helpers rather than the
 * raw client so key-expiry and JSON handling live in one place. Every write is
 * TTL'd — GuildPay never keeps chat context around indefinitely.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisLike) {}

  /** Append to a capped list: push, trim to the last `max`, and (re)set the TTL. */
  async pushCapped(key: string, value: string, max: number, ttlSeconds: number): Promise<void> {
    try {
      await this.client.rpush(key, value);
      await this.client.ltrim(key, -max, -1);
      await this.client.expire(key, ttlSeconds);
    } catch (err) {
      // Context is best-effort — a Redis blip must never break message handling.
      this.logger.warn(`pushCapped(${key}) failed: ${(err as Error).message}`);
    }
  }

  /** Read a list oldest→newest. Returns [] on any error. */
  async list(key: string): Promise<string[]> {
    try {
      return await this.client.lrange(key, 0, -1);
    } catch (err) {
      this.logger.warn(`list(${key}) failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Store a JSON-serialisable value with a TTL. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`setJson(${key}) failed: ${(err as Error).message}`);
    }
  }

  /** Read and parse a JSON value. Returns null if missing or unparseable. */
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`getJson(${key}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`del(${key}) failed: ${(err as Error).message}`);
    }
  }
}
