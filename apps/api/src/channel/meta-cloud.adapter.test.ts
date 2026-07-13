import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MetaCloudAdapter } from './meta-cloud.adapter';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'verify-me';

function makeAdapter(): MetaCloudAdapter {
  const values: Record<string, string> = {
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new MetaCloudAdapter(config);
}

describe('MetaCloudAdapter.verifyToken', () => {
  it('accepts the configured token, rejects others', () => {
    const a = makeAdapter();
    expect(a.verifyToken(VERIFY_TOKEN)).toBe(true);
    expect(a.verifyToken('nope')).toBe(false);
    expect(a.verifyToken(undefined)).toBe(false);
  });
});

describe('MetaCloudAdapter.verifySignature', () => {
  it('accepts a correct HMAC and rejects a tampered body', () => {
    const a = makeAdapter();
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(a.verifySignature(body, sig)).toBe(true);
    expect(a.verifySignature(Buffer.from('tampered'), sig)).toBe(false);
    expect(a.verifySignature(body, 'sha256=deadbeef')).toBe(false);
    expect(a.verifySignature(body, undefined)).toBe(false);
  });
});

describe('MetaCloudAdapter.parseInbound', () => {
  it('extracts a text message and ignores status events', () => {
    const a = makeAdapter();
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.HI',
                    from: '2348012345678',
                    timestamp: '123',
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
            { value: { statuses: [{ status: 'delivered' }] } },
          ],
        },
      ],
    };
    const msgs = a.parseInbound(payload);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      channel: 'meta',
      messageId: 'wamid.HI',
      waPhone: '2348012345678',
      type: 'text',
      text: 'hi',
    });
  });

  it('maps an interactive button reply', () => {
    const a = makeAdapter();
    const msgs = a.parseInbound({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '234',
                    type: 'interactive',
                    interactive: { button_reply: { id: 'confirm', title: 'Confirm' } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(msgs[0]).toMatchObject({ type: 'interactive', interactiveReplyId: 'confirm' });
  });
});
