import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '@guildpay/shared';
import { OnboardingService } from './onboarding.service';
import type { ChannelAdapter, OutboundMessage } from '../channel/channel-adapter';
import type { UserRow, UsersRepository } from '../database/users.repository';
import type { WalletsRepository } from '../database/wallets.repository';
import type { AuditRepository } from '../database/audit.repository';
import type { PartnerService } from '../partner/partner.service';
import { PinService } from '../banking/pin.service';

function baseUser(waPhone: string): UserRow {
  return {
    id: 'u1',
    wa_phone: waPhone,
    full_name: null,
    first_name: null,
    last_name: null,
    email: null,
    language: 'en',
    market: null,
    currency: null,
    kyc_id: null,
    kyc_status: 'pending',
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

  const svc = new OnboardingService(channel, users, wallets, audit, partners, new PinService());
  return { svc, sent, users, wallets, partners, createVirtualAccount };
}

function msg(over: Partial<InboundMessage>): InboundMessage {
  return { channel: 'meta', waPhone: '234', type: 'text', timestamp: '1', raw: {}, ...over };
}

const last = (sent: OutboundMessage[]) => sent[sent.length - 1]!;
const lastBody = (sent: OutboundMessage[]): string => {
  const m = last(sent);
  return 'body' in m ? m.body : '';
};

describe('OnboardingService', () => {
  it('walks a new user through to an active wallet', async () => {
    const h = harness();

    // first contact → user created + language prompt (List message)
    expect(await h.svc.handle(msg({ text: 'hi' }))).toBe(true);
    expect(h.users.create).toHaveBeenCalledOnce();
    expect(last(h.sent).kind).toBe('list');

    // language
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'lang_en' }));
    expect(lastBody(h.sent)).toContain('full name');

    // name → asks for email
    await h.svc.handle(msg({ text: 'Ada Lovelace' }));
    expect(lastBody(h.sent)).toContain('email');

    // email → market buttons
    await h.svc.handle(msg({ text: 'ada@example.com' }));
    expect(last(h.sent).kind).toBe('interactive'); // market buttons

    // market NG → asks for BVN
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'market_ng' }));
    expect(lastBody(h.sent)).toContain('BVN');

    // invalid KYC is rejected, valid KYC advances to the PIN step
    await h.svc.handle(msg({ text: '123' }));
    expect(lastBody(h.sent)).toContain("doesn't look right");
    await h.svc.handle(msg({ text: '12345678901' }));
    expect(lastBody(h.sent)).toContain('PIN');

    // invalid PIN rejected, valid 4-digit PIN advances to consent
    await h.svc.handle(msg({ text: '12' }));
    expect(lastBody(h.sent)).toContain('4 digits');
    await h.svc.handle(msg({ text: '4821' }));
    expect(last(h.sent).kind).toBe('interactive'); // consent buttons
    expect(lastBody(h.sent)).toContain('PIN saved');

    // consent → wallet created + welcome
    const handled = await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'consent_yes' }));
    expect(handled).toBe(true);
    expect(h.wallets.create).toHaveBeenCalledOnce();
    expect(h.createVirtualAccount).toHaveBeenCalledOnce(); // NGN provisions a NUBAN
    expect(lastBody(h.sent)).toContain("all set");
    expect(lastBody(h.sent)).toContain('GPA-NG-');
    expect(lastBody(h.sent)).toContain('9900001111'); // funding account shown
    expect(lastBody(h.sent)).toContain('Wema Bank');
  });

  it('QAR onboarding provisions a simulated account and shows it', async () => {
    const h = harness();
    await h.svc.handle(msg({ text: 'hi' }));
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'lang_en' }));
    await h.svc.handle(msg({ text: 'Noor Ali' }));
    await h.svc.handle(msg({ text: 'noor@example.com' }));
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'market_qa' })); // Qatar
    await h.svc.handle(msg({ text: '12345678901' })); // QID
    await h.svc.handle(msg({ text: '4821' })); // transaction PIN
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'consent_yes' }));
    expect(h.wallets.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'QAR' }));
    expect(h.createVirtualAccount).toHaveBeenCalledOnce();
    expect(lastBody(h.sent)).toContain('GPA-QA-');
  });

  it('returns false (not handled) once onboarded', async () => {
    const h = harness();
    await h.svc.handle(msg({ text: 'hi' })); // create at step language
    // force to done
    await h.svc['users'].update('u1', { onboarding_step: 'done' });
    expect(await h.svc.handle(msg({ text: 'balance' }))).toBe(false);
  });
});
