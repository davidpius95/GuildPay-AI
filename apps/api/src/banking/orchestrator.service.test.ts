import { describe, expect, it, vi } from 'vitest';
import { OrchestratorService } from './orchestrator.service';
import type { AiService } from '../ai/ai.service';

function make(reply: string | string[]) {
  const replies = Array.isArray(reply) ? [...reply] : [reply];
  const ai = {
    complete: vi.fn(async () => replies.shift() ?? replies[replies.length - 1]),
  } as unknown as AiService;
  return new OrchestratorService(ai);
}

describe('OrchestratorService', () => {
  it('parses a clean JSON transfer intent', async () => {
    const svc = make('{"intent":"p2p_transfer","amount":2000,"recipientRef":"08031234567","purpose":null,"confidence":0.9}');
    const r = await svc.parse('send 2000 to 08031234567');
    expect(r.intent).toBe('p2p_transfer');
    expect(r.amount).toBe(2000);
    expect(r.recipientRef).toBe('08031234567');
  });

  it('extracts JSON even when wrapped in prose/fences', async () => {
    const svc = make('Sure! ```json\n{"intent":"balance","confidence":0.8}\n``` done');
    const r = await svc.parse('what is my balance');
    expect(r.intent).toBe('balance');
  });

  it('falls back to "unknown" when the model never returns JSON', async () => {
    const svc = make(['no json here', 'still nothing']);
    const r = await svc.parse('hello there');
    expect(r.intent).toBe('unknown');
  });

  it('never invents an amount (null stays null)', async () => {
    const svc = make('{"intent":"p2p_transfer","amount":null,"recipientRef":null,"confidence":0.4}');
    const r = await svc.parse('send money to my friend');
    expect(r.amount).toBeNull();
    expect(r.recipientRef).toBeNull();
  });
});
