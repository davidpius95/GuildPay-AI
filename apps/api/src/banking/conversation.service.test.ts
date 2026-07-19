import { describe, expect, it } from 'vitest';
import { ConversationService } from './conversation.service';
import { RedisService } from '../redis/redis.service';
import { InMemoryRedis } from '../redis/in-memory-redis';

function make() {
  return new ConversationService(new RedisService(new InMemoryRedis()));
}

describe('ConversationService', () => {
  it('records and replays turns oldest→newest as ChatMessages', async () => {
    const c = make();
    await c.record('u1', 'user', 'send 5000');
    await c.record('u1', 'assistant', 'who should I send it to?');
    await c.record('u1', 'user', '08031234567');
    expect(await c.history('u1')).toEqual([
      { role: 'user', content: 'send 5000' },
      { role: 'assistant', content: 'who should I send it to?' },
      { role: 'user', content: '08031234567' },
    ]);
  });

  it('ignores empty/whitespace content', async () => {
    const c = make();
    await c.record('u1', 'user', '   ');
    expect(await c.history('u1')).toEqual([]);
  });

  it('keeps only the most recent turns (capped window)', async () => {
    const c = make();
    for (let i = 0; i < 12; i++) await c.record('u1', 'user', `m${i}`);
    const h = await c.history('u1');
    expect(h.length).toBe(8);
    expect(h[0]).toEqual({ role: 'user', content: 'm4' });
    expect(h[7]).toEqual({ role: 'user', content: 'm11' });
  });

  it('isolates history per user', async () => {
    const c = make();
    await c.record('u1', 'user', 'hi from u1');
    await c.record('u2', 'user', 'hi from u2');
    expect(await c.history('u2')).toEqual([{ role: 'user', content: 'hi from u2' }]);
  });
});
