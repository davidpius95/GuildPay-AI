import { describe, expect, it } from 'vitest';
import { RedisService } from './redis.service';
import { InMemoryRedis } from './in-memory-redis';

function make() {
  return new RedisService(new InMemoryRedis());
}

describe('RedisService (in-memory backend)', () => {
  it('caps a list to the last N entries', async () => {
    const r = make();
    for (let i = 1; i <= 5; i++) await r.pushCapped('k', String(i), 3, 60);
    expect(await r.list('k')).toEqual(['3', '4', '5']);
  });

  it('round-trips JSON with getJson/setJson', async () => {
    const r = make();
    await r.setJson('j', { a: 1, b: 'x' }, 60);
    expect(await r.getJson<{ a: number; b: string }>('j')).toEqual({ a: 1, b: 'x' });
  });

  it('returns null for a missing key and after del', async () => {
    const r = make();
    expect(await r.getJson('nope')).toBeNull();
    await r.setJson('j', { a: 1 }, 60);
    await r.del('j');
    expect(await r.getJson('j')).toBeNull();
  });

  it('expires entries once their TTL elapses', async () => {
    const client = new InMemoryRedis();
    const r = new RedisService(client);
    await r.setJson('j', { a: 1 }, 1);
    // Simulate time passing without waiting: set a TTL in the past.
    await client.set('j', JSON.stringify({ a: 1 }), 'EX', -1);
    expect(await r.getJson('j')).toBeNull();
  });
});
