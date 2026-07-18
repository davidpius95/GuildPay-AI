import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MetaCloudAdapter } from './meta-cloud.adapter';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'verify-me';

function makeAdapter(extra: Record<string, string> = {}): MetaCloudAdapter {
  const values: Record<string, string> = {
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    ...extra,
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

describe('MetaCloudAdapter.send flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an interactive flow body', async () => {
    const a = makeAdapter({ META_WHATSAPP_TOKEN: 'tok', META_PHONE_NUMBER_ID: 'pn1' });
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => ({ ok: true, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await a.send({
      to: '234800',
      kind: 'flow',
      body: 'Approve?',
      flowId: 'flow-123',
      flowToken: 'tok-abc',
      screenId: 'PIN_SCREEN',
      buttonTitle: 'Verify Transaction',
      mode: 'draft',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: 'Approve?' },
        action: {
          name: 'flow',
          parameters: {
            flow_id: 'flow-123',
            flow_token: 'tok-abc',
            flow_cta: 'Verify Transaction',
            flow_action: 'navigate',
            flow_action_payload: { screen: 'PIN_SCREEN' },
            mode: 'draft',
          },
        },
      },
    });
  });

  it('sends an interactive list body', async () => {
    const a = makeAdapter({ META_WHATSAPP_TOKEN: 'tok', META_PHONE_NUMBER_ID: 'pn1' });
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => ({ ok: true, text: async () => '' }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    await a.send({
      to: '234800',
      kind: 'list',
      body: 'Your balance is ₦100.',
      buttonTitle: 'Menu',
      sections: [
        {
          title: 'Money',
          rows: [
            { id: 'act_fund', title: 'Fund wallet', description: 'Add money' },
            { id: 'act_send', title: 'Send money' },
          ],
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Your balance is ₦100.' },
        action: {
          button: 'Menu',
          sections: [
            {
              title: 'Money',
              rows: [
                { id: 'act_fund', title: 'Fund wallet', description: 'Add money' },
                { id: 'act_send', title: 'Send money' },
              ],
            },
          ],
        },
      },
    });
    // description omitted when absent
    expect(body.interactive.action.sections[0].rows[1]).not.toHaveProperty('description');
  });
});
