import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '@guildpay/shared';
import { OnboardingService } from './onboarding.service';
import type { ChannelAdapter, OutboundMessage } from '../channel/channel-adapter';
import type { UserRow, UsersRepository } from '../database/users.repository';
import type { WalletsRepository } from '../database/wallets.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { PartnerService } from '../partner/partner.service';

function baseUser(waPhone: string): UserRow {
  return {
    id: 'u1',
    wa_phone: waPhone,
    full_name: null,
    language: 'en',
    market: null,
    currency: null,
    kyc_id: null,
    kyc_expiry: null,
    consent_at: null,
    pin_hash: null,
    status: 'pending',
    onboarding_step: 'language',
    created_at: 'now',
    updated_at: 'now',
  };
}

function harness() {
  let user: UserRow | null = null;
  const sent: OutboundMessage[] = [];

  const users = {
    findByWaPhone: vi.fn(async () => user),
    create: vi.fn(async (wa: string) => (user = baseUser(wa))),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      user = { ...(user as UserRow), ...patch } as UserRow;
      return user;
    }),
  } as unknown as UsersRepository;

  const wallets = {
    create: vi.fn(async (p: { reference: string }) => ({ id: 'w1', reference: p.reference })),
    setVirtualAccount: vi.fn(async () => undefined),
  } as unknown as WalletsRepository;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditRepository;
  const channel = {
    send: vi.fn(async (m: OutboundMessage) => {
      sent.push(m);
    }),
  } as unknown as ChannelAdapter;

  const createVirtualAccount = vi.fn(async () => ({
    accountNumber: '9900001111',
    bankName: 'Wema Bank',
    providerRef: 'flw_ref_1',
  }));
  const partners = {
    forCurrency: vi.fn(() => ({ createVirtualAccount })),
  } as unknown as PartnerService;

  const svc = new OnboardingService(channel, users, wallets, audit, partners);
  return { svc, sent, users, wallets, partners, createVirtualAccount };
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return { channel: 'meta', waPhone: '234', type: 'text', timestamp: '1', raw: {}, ...over };
}

const last = (sent: OutboundMessage[]) => sent[sent.length - 1]!;

describe('OnboardingService', () => {
  it('walks a new user through to an active wallet', async () => {
    const h = harness();

    // first contact → user created + language prompt
    expect(await h.svc.handle(msg({ text: 'hi' }))).toBe(true);
    expect(h.users.create).toHaveBeenCalledOnce();
    expect(last(h.sent).kind).toBe('interactive');

    // language
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'lang_en' }));
    expect(last(h.sent).body).toContain('full name');

    // name
    await h.svc.handle(msg({ text: 'Ada Lovelace' }));
    expect(last(h.sent).kind).toBe('interactive'); // market buttons

    // market NG → asks for BVN
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'market_ng' }));
    expect(last(h.sent).body).toContain('BVN');

    // invalid KYC is rejected, valid KYC advances to consent
    await h.svc.handle(msg({ text: '123' }));
    expect(last(h.sent).body).toContain("doesn't look right");
    await h.svc.handle(msg({ text: '12345678901' }));
    expect(last(h.sent).kind).toBe('interactive'); // consent buttons

    // consent → wallet created + welcome
    const handled = await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'consent_yes' }));
    expect(handled).toBe(true);
    expect(h.wallets.create).toHaveBeenCalledOnce();
    expect(h.createVirtualAccount).toHaveBeenCalledOnce(); // NGN provisions a NUBAN
    expect(last(h.sent).body).toContain("all set");
    expect(last(h.sent).body).toContain('GPA-NG-');
    expect(last(h.sent).body).toContain('9900001111'); // funding account shown
    expect(last(h.sent).body).toContain('Wema Bank');
  });

  it('returns false (not handled) once onboarded', async () => {
    const h = harness();
    await h.svc.handle(msg({ text: 'hi' })); // create at step language
    // force to done
    await h.svc['users'].update('u1', { onboarding_step: 'done' });
    expect(await h.svc.handle(msg({ text: 'balance' }))).toBe(false);
  });
});
