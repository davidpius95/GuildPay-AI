/**
 * The subset of Redis commands GuildPay uses. Both the real ioredis client and
 * the in-memory fallback satisfy this, so callers never branch on which is live.
 */
export interface RedisLike {
  rpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<unknown>;
  quit?(): Promise<unknown>;
}

interface Entry {
  list?: string[];
  value?: string;
  expiresAt?: number; // epoch ms; undefined = no expiry
}

/**
 * Process-local stand-in for Redis, used when REDIS_URL is unset (tests, local
 * dev without a Redis). Same command surface as ioredis for the ops we use, with
 * lazy TTL expiry on access. Not shared across processes — fine for a single-node
 * MVP and for tests; production sets REDIS_URL and gets the real client.
 */
export class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, Entry>();

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const e = this.live(key) ?? {};
    e.list = [...(e.list ?? []), ...values];
    this.store.set(key, e);
    return e.list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const e = this.live(key);
    if (e?.list) {
      // Normalise negative indices the way Redis does, then slice inclusive.
      const len = e.list.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const t = stop < 0 ? len + stop : stop;
      e.list = t < s ? [] : e.list.slice(s, t + 1);
    }
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const e = this.live(key);
    if (!e?.list) return [];
    const len = e.list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const t = stop < 0 ? len + stop : stop;
    return t < s ? [] : e.list.slice(s, t + 1);
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number): Promise<'OK'> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }
}
