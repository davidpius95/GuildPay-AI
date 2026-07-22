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
    id_type: null,
    kyc_status: 'pending',
    kyc_reference: null,
    kyc_expiry: null,
    address_street: null,
    address_city: null,
    address_state: null,
    referral_code: null,
    consent_at: null,
    pin_hash: null,
    status: 'pending',
    onboarding_step: 'language',
    created_at: 'now',
    updated_at: 'now',
  };
}

function harness(opts: { channelName?: 'meta' | 'twilio'; onboardingFlow?: boolean } = {}) {
  let user: UserRow | null = null;
  const sent: OutboundMessage[] = [];

  const users = {
    findByWaPhone: vi.fn(async () => user),
    findById: vi.fn(async () => user),
    create: vi.fn(async (wa: string) => (user = baseUser(wa))),
    update: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      user = { ...(user as UserRow), ...patch } as UserRow;
      return user;
    }),
  } as unknown as UsersRepository;

  let wallet: Record<string, unknown> | null = null;
  const wallets = {
    create: vi.fn(async (p: { reference: string; currency: string; market: string }) => {
      wallet = {
        id: 'w1',
        reference: p.reference,
        currency: p.currency,
        market: p.market,
        virtual_account_number: null,
        virtual_bank_name: null,
        virtual_account_ref: null,
      };
      return wallet;
    }),
    setVirtualAccount: vi.fn(async (_id: string, acct: string, bank: string, ref?: string) => {
      if (wallet) {
        wallet.virtual_account_number = acct;
        wallet.virtual_bank_name = bank;
        wallet.virtual_account_ref = ref ?? null;
      }
    }),
    findByUserId: vi.fn(async () => (wallet ? [wallet] : [])),
  } as unknown as WalletsRepository;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditRepository;
  const channel = {
    name: opts.channelName ?? 'twilio',
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

  const flows = {
    isEnabled: vi.fn(() => false),
    isOnboardingEnabled: vi.fn(() => opts.onboardingFlow ?? false),
    buildSetupPinFlowMessage: vi.fn(() => ({ kind: 'flow' })),
    buildOnboardingFlowMessage: vi.fn((to: string, userId: string) => ({
      to,
      kind: 'flow',
      body: 'Please tap the button below to complete your onboarding.',
      flowId: 'obf_1',
      flowToken: `obflow_${userId}`,
      screenId: 'WELCOME',
      buttonTitle: 'Complete Onboarding',
    })),
  } as unknown as import('../channel/whatsapp-flow.service').WhatsappFlowService;

  const svc = new OnboardingService(channel, flows, users, wallets, audit, partners, new PinService());
  return { svc, sent, users, wallets, partners, createVirtualAccount, flows };
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

    // invalid KYC is rejected; a valid BVN is verified in-chat and advances to PIN
    await h.svc.handle(msg({ text: '123' }));
    expect(lastBody(h.sent)).toContain("doesn't look right");
    await h.svc.handle(msg({ text: '12345678901' }));
    expect(h.createVirtualAccount).toHaveBeenCalledOnce(); // NGN verifies + provisions NUBAN
    expect(lastBody(h.sent)).toContain('PIN');

    // invalid PIN rejected, valid 4-digit PIN advances to consent
    await h.svc.handle(msg({ text: '12' }));
    expect(lastBody(h.sent)).toContain('4 digits');
    await h.svc.handle(msg({ text: '4821' }));
    expect(last(h.sent).kind).toBe('interactive'); // consent buttons
    expect(lastBody(h.sent)).toContain('PIN saved');

    // consent → wallet activated + welcome
    const handled = await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'consent_yes' }));
    expect(handled).toBe(true);
    expect(h.wallets.create).toHaveBeenCalledOnce();
    expect(h.createVirtualAccount).toHaveBeenCalledOnce(); // NGN provisions a NUBAN
    expect(lastBody(h.sent)).toContain("all set");
    expect(lastBody(h.sent)).toContain('GPA-NG-');
    expect(lastBody(h.sent)).toContain('9900001111'); // funding account shown
    expect(lastBody(h.sent)).toContain('Wema Bank');
  });

  it('blocks an invalid BVN in-chat — no wallet, stays on the KYC step, then re-verifies', async () => {
    const h = harness();
    await h.svc.handle(msg({ text: 'hi' }));
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'lang_en' }));
    await h.svc.handle(msg({ text: 'Ada Lovelace' }));
    await h.svc.handle(msg({ text: 'ada@example.com' }));
    await h.svc.handle(msg({ type: 'interactive', interactiveReplyId: 'market_ng' }));

    // Flutterwave rejects a bad BVN when issuing the NUBAN → verification fails in-chat.
    h.createVirtualAccount.mockRejectedValueOnce(new Error('BVN could not be verified'));
    await h.svc.handle(msg({ text: '99999999999' }));
    expect(lastBody(h.sent)).toContain('could not be verified');
    expect(h.wallets.create).not.toHaveBeenCalled(); // no wallet on failure
    // KYC status recorded as failed, user NOT advanced past the kyc step.
    const failedUpdate = (h.users.update as ReturnType<typeof vi.fn>).mock.calls.some(
      ([, patch]) => (patch as Record<string, unknown>).kyc_status === 'failed',
    );
    expect(failedUpdate).toBe(true);

    // Re-entering a valid BVN verifies + provisions and advances to the PIN step.
    await h.svc.handle(msg({ text: '12345678901' }));
    expect(lastBody(h.sent)).toContain('PIN');
    expect(h.wallets.create).toHaveBeenCalledOnce();
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

  describe('native onboarding Flow (Meta)', () => {
    it('launches the Complete Onboarding modal for a new Meta user instead of the chat wizard', async () => {
      const h = harness({ channelName: 'meta', onboardingFlow: true });
      expect(await h.svc.handle(msg({ text: 'hi' }))).toBe(true);
      expect(h.users.create).toHaveBeenCalledOnce();
      const flowMsg = h.sent.find((m) => m.kind === 'flow');
      expect(flowMsg).toBeDefined();
      expect((flowMsg as { buttonTitle: string }).buttonTitle).toBe('Complete Onboarding');
      // No chat language list is sent when the Flow drives onboarding.
      expect(h.sent.some((m) => m.kind === 'list')).toBe(false);
    });

    it('drives the modal screens: welcome → account details (provisions NUBAN) → address → PIN → active', async () => {
      const h = harness({ channelName: 'meta', onboardingFlow: true });
      await h.svc.handle(msg({ text: 'hi' })); // creates user + sends flow
      const userId = 'u1';

      // INIT opens the welcome screen.
      expect((await h.svc.handleFlowExchange(userId, 'INIT', undefined, {})).screen).toBe('WELCOME');

      // Consent → account details.
      expect((await h.svc.handleFlowExchange(userId, 'data_exchange', 'WELCOME', {})).screen).toBe(
        'ACCOUNT_DETAILS',
      );

      // Account details validated → provisions the NUBAN → advances to address.
      const acct = await h.svc.handleFlowExchange(userId, 'data_exchange', 'ACCOUNT_DETAILS', {
        first_name: 'Ada',
        last_name: 'Obi',
        id_type: 'BVN',
        id_number: '12345678901',
        email: '',
        referral: '',
      });
      expect(acct.screen).toBe('ADDRESS');
      expect(h.createVirtualAccount).toHaveBeenCalledOnce();
      expect(h.wallets.create).toHaveBeenCalledWith(expect.objectContaining({ currency: 'NGN' }));

      // Address → PIN.
      const addr = await h.svc.handleFlowExchange(userId, 'data_exchange', 'ADDRESS', {
        street: '1 Marina',
        city: 'Lagos',
        state: 'Lagos',
      });
      expect(addr.screen).toBe('PIN');

      // PIN set + confirmed → terminal SUCCESS + funding card pushed to chat.
      const pin = await h.svc.handleFlowExchange(userId, 'data_exchange', 'PIN', {
        pin: '4821',
        retype: '4821',
      });
      expect(pin.screen).toBe('SUCCESS');
      expect(h.sent.some((m) => 'body' in m && m.body.includes('9900001111'))).toBe(true);
      expect(h.sent.some((m) => 'body' in m && m.body.includes('Central Bank of Nigeria'))).toBe(true);
    });

    it('re-shows Account Details with an inline error when the BVN fails — no NUBAN advance', async () => {
      const h = harness({ channelName: 'meta', onboardingFlow: true });
      await h.svc.handle(msg({ text: 'hi' }));
      h.createVirtualAccount.mockRejectedValueOnce(new Error('BVN could not be verified'));
      const res = await h.svc.handleFlowExchange('u1', 'data_exchange', 'ACCOUNT_DETAILS', {
        first_name: 'Ada',
        last_name: 'Obi',
        id_type: 'BVN',
        id_number: '99999999999',
      });
      expect(res.screen).toBe('ACCOUNT_DETAILS');
      expect(res.data?.has_error).toBe(true);
      expect(String(res.data?.error_message)).toContain('could not be verified');
      expect(h.wallets.create).not.toHaveBeenCalled();
    });

    it('rejects mismatched PINs on the PIN screen', async () => {
      const h = harness({ channelName: 'meta', onboardingFlow: true });
      await h.svc.handle(msg({ text: 'hi' }));
      await h.svc.handleFlowExchange('u1', 'data_exchange', 'ACCOUNT_DETAILS', {
        first_name: 'Ada',
        last_name: 'Obi',
        id_type: 'BVN',
        id_number: '12345678901',
      });
      await h.svc.handleFlowExchange('u1', 'data_exchange', 'ADDRESS', {
        street: '1 Marina',
        city: 'Lagos',
        state: 'Lagos',
      });
      const res = await h.svc.handleFlowExchange('u1', 'data_exchange', 'PIN', {
        pin: '4821',
        retype: '9999',
      });
      expect(res.screen).toBe('PIN');
      expect(res.data?.has_error).toBe(true);
    });
  });
});
