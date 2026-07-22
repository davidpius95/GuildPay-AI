import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { CURRENCY_META, type Currency, type InboundMessage, type Market } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import {
  FLOW_SUCCESS_SCREEN,
  ONBOARDING_SCREENS,
  WhatsappFlowService,
} from '../channel/whatsapp-flow.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository } from '../database/wallets.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type { CreateVirtualAccountResult } from '../partner/partner-adapter';
import { PinService } from '../banking/pin.service';

const MARKET_CURRENCY: Record<Market, Currency> = { NG: 'NGN', QA: 'QAR' };
const KYC_LABEL: Record<Market, string> = { NG: 'BVN', QA: 'QID' };

/** Treat blank WhatsApp Flow inputs ('') as absent. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Validates the Account Details screen of the native onboarding Flow. */
const accountDetailsSchema = z.object({
  first_name: z.string().trim().min(1),
  last_name: z.string().trim().min(1),
  id_type: z.enum(['BVN', 'NIN']),
  id_number: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\s/g, '') : v),
    z.string().regex(/^\d{11}$/),
  ),
  email: z.preprocess(blankToUndefined, z.string().trim().email().optional()),
  referral: z.preprocess(blankToUndefined, z.string().trim().optional()),
});

/** Validates the Address screen of the native onboarding Flow. */
const addressSchema = z.object({
  street: z.string().trim().min(1),
  city: z.string().trim().min(1),
  state: z.string().trim().min(1),
});

/** A response body for one onboarding Flow screen exchange (no version/token — the controller adds those). */
export interface FlowScreenResponse {
  screen: string;
  data?: Record<string, unknown>;
}

/**
 * Deterministic onboarding state machine (no LLM). Drives a first-time user
 * through language → name → market → KYC → consent, then creates the user's
 * wallet. State lives in users.onboarding_step so it survives restarts.
 * Returns true if it handled the message; false once the user is onboarded.
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly flows: WhatsappFlowService,
    private readonly users: UsersRepository,
    private readonly wallets: WalletsRepository,
    private readonly audit: AuditRepository,
    private readonly partners: PartnerService,
    private readonly pins: PinService,
  ) {}

  async handle(msg: InboundMessage): Promise<boolean> {
    let user = await this.users.findByWaPhone(msg.waPhone);

    if (!user) {
      user = await this.users.create(msg.waPhone);
      await this.audit.record({ userId: user.id, action: 'onboarding_started', entity: 'user' });
      // Xara-style native onboarding modal when configured (Meta only); otherwise
      // fall back to the deterministic chat wizard.
      if (this.channel.name === 'meta' && this.flows.isOnboardingEnabled?.()) {
        await this.users.update(user.id, { onboarding_step: 'flow' });
        await this.sendOnboardingFlow(user.wa_phone, user.id, true);
        return true;
      }
      await this.promptLanguage(msg.waPhone);
      return true;
    }

    switch (user.onboarding_step) {
      case 'flow':
        // User is mid-flow but typed in the chat — re-offer the modal.
        await this.sendOnboardingFlow(user.wa_phone, user.id, false);
        return true;
      case 'language':
        return this.stepLanguage(user, msg);
      case 'name':
        return this.stepName(user, msg);
      case 'email':
        return this.stepEmail(user, msg);
      case 'market':
        return this.stepMarket(user, msg);
      case 'kyc':
        return this.stepKyc(user, msg);
      case 'pin':
        return this.stepPin(user, msg);
      case 'consent':
        return this.stepConsent(user, msg);
      default:
        return false; // onboarded — let the caller handle it
    }
  }

  // ── steps ──────────────────────────────────────────────────────────────────

  private async stepLanguage(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const lang = { lang_en: 'en', lang_pidgin: 'pidgin', lang_ar: 'ar' }[msg.interactiveReplyId ?? ''];
    if (!lang) return this.promptLanguage(user.wa_phone), true;
    await this.users.update(user.id, { language: lang, onboarding_step: 'name' });
    await this.text(user.wa_phone, "Great! What's your *full name*?");
    return true;
  }

  private async stepName(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const name = msg.text?.trim().replace(/\s+/g, ' ');
    if (!name || !name.includes(' ')) {
      await this.text(user.wa_phone, 'Please type your *full name* (first and last), e.g. Ada Obi.');
      return true;
    }
    const [firstName, ...rest] = name.split(' ');
    await this.users.update(user.id, {
      full_name: name,
      first_name: firstName,
      last_name: rest.join(' '),
      onboarding_step: 'email',
    });
    await this.text(user.wa_phone, `Thanks, ${firstName}! What's your *email address*? (for receipts and your account)`);
    return true;
  }

  private async stepEmail(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const email = (msg.text ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await this.text(user.wa_phone, "That doesn't look like a valid email. Please enter it again, e.g. ada@example.com.");
      return true;
    }
    await this.users.update(user.id, { email, onboarding_step: 'market' });
    await this.promptMarket(user.wa_phone, user.first_name ?? user.full_name ?? '');
    return true;
  }

  private async stepMarket(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const market = { market_ng: 'NG', market_qa: 'QA' }[msg.interactiveReplyId ?? ''] as
      | Market
      | undefined;
    if (!market) return this.promptMarket(user.wa_phone, user.full_name ?? ''), true;
    await this.users.update(user.id, {
      market,
      currency: MARKET_CURRENCY[market],
      onboarding_step: 'kyc',
    });
    await this.text(
      user.wa_phone,
      `Almost done. Please enter your 11-digit *${KYC_LABEL[market]}* (numbers only) to verify your identity.`,
    );
    return true;
  }

  /**
   * KYC step — verify the government ID at the backend, entirely in-chat, then
   * provision. For NGN the BVN is validated by Flutterwave when it provisions the
   * permanent NUBAN (a wrong/invalid BVN is rejected synchronously), so the user
   * never leaves WhatsApp. For QAR the (simulated) QID resolves on the mock rail.
   * No wallet or account number is created unless the ID passes.
   */
  private async stepKyc(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const market = (user.market ?? 'NG') as Market;
    const kyc = (msg.text ?? '').replace(/\s/g, '');
    if (!/^\d{11}$/.test(kyc)) {
      await this.text(
        user.wa_phone,
        `That doesn't look right — please enter your 11-digit *${KYC_LABEL[market]}* (numbers only).`,
      );
      return true;
    }
    return this.provisionWalletAndAdvance(user, market, kyc);
  }

  /**
   * Provision the wallet + funding account for a verified identity and advance to
   * the PIN step. For NGN this is also where the BVN is verified: Flutterwave
   * validates the BVN as it issues the NUBAN and rejects a bad one, which we turn
   * into a "re-enter your BVN" prompt. Never logs/audits the full account number or ID.
   */
  private async provisionWalletAndAdvance(
    user: UserRow,
    market: Market,
    kyc: string,
  ): Promise<boolean> {
    const result = await this.provisionWallet(user, market, kyc);
    if (!result.ok) {
      await this.users.update(user.id, { onboarding_step: 'kyc' });
      await this.text(
        user.wa_phone,
        result.badId
          ? `❌ That ${KYC_LABEL[market]} could not be verified.\n\n` +
              `Please double-check the 11 digits and send your *${KYC_LABEL[market]}* again (numbers only).`
          : `⚠️ I couldn't verify your ${KYC_LABEL[market]} right now — the service didn't respond.\n\n` +
              `Please send your 11-digit *${KYC_LABEL[market]}* again in a moment.`,
      );
      return true;
    }
    await this.users.update(user.id, { onboarding_step: 'pin' });
    await this.sendPinPrompt(user, market);
    return true;
  }

  /**
   * Verify the government ID and provision the wallet + funding account. Pure of
   * chat side effects and onboarding-step transitions so it can back both the chat
   * wizard and the native onboarding Flow. For NGN the BVN is validated by
   * Flutterwave as it issues the NUBAN (a bad ID is rejected synchronously). On
   * success the user's kyc_id/kyc_status are set to verified. Never logs the raw ID.
   */
  private async provisionWallet(
    user: UserRow,
    market: Market,
    kyc: string,
  ): Promise<{ ok: true; wallet: Awaited<ReturnType<WalletsRepository['create']>> } | { ok: false; badId: boolean }> {
    const currency = MARKET_CURRENCY[market];
    const firstName = user.first_name ?? (user.full_name ?? '').trim().split(/\s+/)[0];
    const lastName = user.last_name ?? firstName;
    const reference = `GPA-${market}-${randomBytes(3).toString('hex').toUpperCase()}`;
    let account: CreateVirtualAccountResult;
    try {
      account = await this.partners.forCurrency(currency).createVirtualAccount({
        userRef: reference,
        email: user.email ?? this.syntheticEmail(user.wa_phone),
        firstName: firstName || undefined,
        lastName: lastName || firstName || undefined,
        phone: user.wa_phone,
        bvn: kyc,
      });
    } catch (err) {
      // Never log the raw ID. Distinguish "the ID is wrong" from a transient error.
      const reason = (err as Error).message ?? '';
      this.logger.warn(`KYC/account provisioning failed for user ${user.id}: ${reason}`);
      await this.users.update(user.id, { kyc_status: 'failed' });
      await this.audit.record({
        userId: user.id,
        action: 'kyc_failed',
        entity: 'user',
        entityId: user.id,
        metadata: { type: KYC_LABEL[market].toLowerCase() },
      });
      return { ok: false, badId: /bvn|nin|invalid|not\s*found|mismatch|verif/i.test(reason) };
    }

    const wallet = await this.wallets.create({ userId: user.id, reference, currency, market });
    await this.wallets.setVirtualAccount(
      wallet.id,
      account.accountNumber,
      account.bankName,
      account.providerRef,
    );
    await this.users.update(user.id, { kyc_id: kyc, kyc_status: 'verified' });
    await this.audit.record({
      userId: user.id,
      action: 'wallet_created',
      entity: 'wallet',
      entityId: wallet.id,
      metadata: { reference, currency },
    });
    await this.audit.record({
      userId: user.id,
      action: 'virtual_account_created',
      entity: 'wallet',
      entityId: wallet.id,
      metadata: { bank: account.bankName },
    });
    return { ok: true, wallet };
  }

  /** Prompt the user to set their 4-digit PIN — via the secure WhatsApp Flow when available, else chat. */
  private async sendPinPrompt(user: UserRow, market: Market): Promise<void> {
    if (this.channel.name === 'meta' && this.flows.isEnabled()) {
      await this.channel.send(
        this.flows.buildSetupPinFlowMessage(
          user.wa_phone,
          user.id,
          `✅ ${KYC_LABEL[market]} verified.\n\n🔐 Now set your *4-digit transaction PIN*.\nTap *Set PIN* to enter it securely.`,
        ),
      );
    } else {
      await this.text(
        user.wa_phone,
        `✅ ${KYC_LABEL[market]} verified.\n\n` +
          '🔐 Now set your *4-digit transaction PIN* (numbers only).\n\n' +
          "You'll enter this PIN to approve every transfer, so keep it secret. " +
          'You can delete your message after I confirm it.',
      );
    }
  }

  /** Set the 4-digit transaction PIN via chat fallback (hashed; the raw PIN is never stored or logged). */
  private async stepPin(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const pin = (msg.text ?? '').replace(/\s/g, '');
    if (!this.pins.isValidFormat(pin)) {
      await this.text(user.wa_phone, 'Your PIN must be exactly *4 digits* (e.g. 4821). Please try again.');
      return true;
    }
    await this.users.update(user.id, { pin_hash: this.pins.hash(pin), onboarding_step: 'consent' });
    await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
    await this.buttons(user.wa_phone, '✅ PIN saved.\n\nBy continuing you agree to GuildPay’s Terms & Privacy. Create your wallet now?', [
      { id: 'consent_yes', title: 'I agree ✅' },
      { id: 'consent_no', title: 'Cancel' },
    ]);
    return true;
  }

  /** Process the 4-digit transaction PIN received securely from the WhatsApp Flow modal. */
  async submitPinFlow(userId: string, pin: string): Promise<'success' | 'stale' | 'invalid'> {
    const user = await this.users.findById(userId);
    if (!user || user.onboarding_step !== 'pin') return 'stale';

    const cleanPin = pin.replace(/\s/g, '');
    if (!this.pins.isValidFormat(cleanPin)) {
      return 'invalid';
    }

    await this.users.update(user.id, { pin_hash: this.pins.hash(cleanPin), onboarding_step: 'consent' });
    await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
    
    // Push the next step to the chat asynchronously
    await this.buttons(user.wa_phone, '✅ PIN saved.\n\nBy continuing you agree to GuildPay’s Terms & Privacy. Create your wallet now?', [
      { id: 'consent_yes', title: 'I agree ✅' },
      { id: 'consent_no', title: 'Cancel' },
    ]);
    return 'success';
  }

  // ── native onboarding Flow (Xara-style multi-screen modal) ───────────────────

  /** Send the "Complete Onboarding" Flow message (with a first-time greeting). */
  private async sendOnboardingFlow(to: string, userId: string, firstTime: boolean): Promise<void> {
    if (firstTime) {
      await this.text(to, '👋 Welcome to *GuildPay* — everyday money, made conversational.');
    }
    await this.channel.send(this.flows.buildOnboardingFlowMessage(to, userId));
  }

  /**
   * Drive one screen exchange of the native onboarding Flow. The encrypted Flow
   * controller decrypts the request and calls this with the current screen + form
   * data; we validate, persist, run the shared provisioning, and return the next
   * screen (or an inline error on the same screen). The raw PIN and ID never touch
   * the chat thread and are never logged.
   */
  async handleFlowExchange(
    userId: string,
    action: string,
    screen: string | undefined,
    data: Record<string, unknown>,
  ): Promise<FlowScreenResponse> {
    const user = await this.users.findById(userId);
    if (!user) return this.flowTerminal('error', 'Your session expired. Please message us to start again.');

    if (user.onboarding_step === 'done' || user.status === 'active') {
      return this.flowTerminal('already_done', 'Your account is already set up. Check your chat. 💬');
    }

    if (action === 'INIT' || action === 'BACK') {
      return { screen: ONBOARDING_SCREENS.WELCOME, data: {} };
    }

    switch (screen) {
      case ONBOARDING_SCREENS.WELCOME:
        await this.users.update(user.id, { consent_at: 'now' });
        return { screen: ONBOARDING_SCREENS.ACCOUNT_DETAILS, data: {} };
      case ONBOARDING_SCREENS.ACCOUNT_DETAILS:
        return this.flowAccountDetails(user, data);
      case ONBOARDING_SCREENS.ADDRESS:
        return this.flowAddress(user, data);
      case ONBOARDING_SCREENS.PIN:
        return this.flowPin(user, data);
      default:
        return { screen: ONBOARDING_SCREENS.WELCOME, data: {} };
    }
  }

  /** Account Details screen → validate, store profile, verify ID + provision NUBAN. */
  private async flowAccountDetails(user: UserRow, data: Record<string, unknown>): Promise<FlowScreenResponse> {
    const parsed = accountDetailsSchema.safeParse(data);
    if (!parsed.success) {
      return this.flowScreenError(
        ONBOARDING_SCREENS.ACCOUNT_DETAILS,
        'Please enter your first name, last name, ID type, and a valid 11-digit ID number.',
      );
    }
    const { first_name, last_name, id_type, id_number, email, referral } = parsed.data;
    const market: Market = 'NG'; // the native onboarding Flow is NGN (BVN/NIN)
    const fullName = `${first_name} ${last_name}`.trim();
    await this.users.update(user.id, {
      first_name,
      last_name,
      full_name: fullName,
      id_type,
      market,
      currency: MARKET_CURRENCY[market],
      ...(email ? { email } : {}),
      ...(referral ? { referral_code: referral } : {}),
    });

    const enriched: UserRow = {
      ...user,
      first_name,
      last_name,
      full_name: fullName,
      market,
      currency: MARKET_CURRENCY[market],
      email: email ?? user.email,
    };
    const result = await this.provisionWallet(enriched, market, id_number);
    if (!result.ok) {
      return this.flowScreenError(
        ONBOARDING_SCREENS.ACCOUNT_DETAILS,
        result.badId
          ? `That ${id_type} could not be verified. Please check the 11 digits and try again.`
          : `We couldn't verify your ${id_type} right now. Please try again in a moment.`,
      );
    }
    return { screen: ONBOARDING_SCREENS.ADDRESS, data: {} };
  }

  /** Address screen → validate + store the postal address. */
  private async flowAddress(user: UserRow, data: Record<string, unknown>): Promise<FlowScreenResponse> {
    const parsed = addressSchema.safeParse(data);
    if (!parsed.success) {
      return this.flowScreenError(ONBOARDING_SCREENS.ADDRESS, 'Please provide your street, city, and state.');
    }
    await this.users.update(user.id, {
      address_street: parsed.data.street,
      address_city: parsed.data.city,
      address_state: parsed.data.state,
    });
    return { screen: ONBOARDING_SCREENS.PIN, data: {} };
  }

  /** PIN screen → validate + confirm, hash + activate, then push the funding card to chat. */
  private async flowPin(user: UserRow, data: Record<string, unknown>): Promise<FlowScreenResponse> {
    const pin = String(data['pin'] ?? '').replace(/\s/g, '');
    const retype = String(data['retype'] ?? '').replace(/\s/g, '');
    if (!this.pins.isValidFormat(pin)) {
      return this.flowScreenError(ONBOARDING_SCREENS.PIN, 'Your PIN must be exactly 4 digits.');
    }
    if (pin !== retype) {
      return this.flowScreenError(ONBOARDING_SCREENS.PIN, 'The two PINs did not match. Please re-enter them.');
    }
    const [wallet] = await this.wallets.findByUserId(user.id);
    if (!wallet) {
      // Provisioning somehow never ran — bounce back to Account Details.
      return this.flowScreenError(
        ONBOARDING_SCREENS.ACCOUNT_DETAILS,
        'Let’s re-verify your identity first. Please re-enter your details.',
      );
    }
    await this.users.update(user.id, {
      pin_hash: this.pins.hash(pin),
      status: 'active',
      onboarding_step: 'done',
      consent_at: 'now',
    });
    await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
    await this.audit.record({
      userId: user.id,
      action: 'onboarding_completed',
      entity: 'user',
      entityId: user.id,
      metadata: { reference: wallet.reference, currency: wallet.currency },
    });
    await this.sendFundingDetails(user, wallet);
    return this.flowTerminal('success', 'Your PIN is set and your account is ready! Check your chat. 💬');
  }

  /** Send the Xara-style funding card to the chat after the onboarding modal closes. */
  private async sendFundingDetails(
    user: UserRow,
    wallet: Awaited<ReturnType<WalletsRepository['create']>>,
  ): Promise<void> {
    const currency = (wallet.currency ?? 'NGN') as Currency;
    const symbol = CURRENCY_META[currency].symbol;
    await this.text(
      user.wa_phone,
      `🎉 You're all set, ${user.first_name ?? user.full_name ?? 'there'}!\n\n` +
        `*Your GuildPay wallet* is ready.\nBalance: ${symbol}0.00`,
    );
    if (wallet.virtual_account_number) {
      await this.text(
        user.wa_phone,
        `To fund your wallet, send any amount to your Virtual Bank Account below:\n\n` +
          `*Account Number:* ${wallet.virtual_account_number}\n` +
          `*Account Name:* ${user.full_name ?? 'GuildPay user'}\n` +
          `*Bank Name:* ${wallet.virtual_bank_name}\n\n` +
          `ℹ️ Deposits are held by Flutterwave, a licensed microfinance bank by the Central Bank of Nigeria.`,
      );
    }
    await this.text(
      user.wa_phone,
      'You can now send money, buy airtime and pay bills — just tell me what you need. 💬',
    );
  }

  /** Re-show a screen with an inline error banner (bound to `${data.error_message}`). */
  private flowScreenError(screen: string, message: string): FlowScreenResponse {
    return { screen, data: { has_error: true, error_message: `⚠️ ${message}` } };
  }

  /** Close the Flow modal with a terminal SUCCESS screen carrying a result + message. */
  private flowTerminal(result: string, message: string): FlowScreenResponse {
    return {
      screen: FLOW_SUCCESS_SCREEN,
      data: { extension_message_response: { params: { result, message } } },
    };
  }

  private async stepConsent(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const choice = msg.interactiveReplyId;
    if (choice === 'consent_no') {
      await this.text(user.wa_phone, 'No problem — your details are saved. Send any message when you’re ready to finish.');
      return true;
    }
    if (choice !== 'consent_yes') {
      await this.buttons(user.wa_phone, 'Please tap a button to continue.', [
        { id: 'consent_yes', title: 'I agree ✅' },
        { id: 'consent_no', title: 'Cancel' },
      ]);
      return true;
    }

    const market = (user.market ?? 'NG') as Market;
    const currency = MARKET_CURRENCY[market];
    // The wallet + funding account were created at the verified KYC step; consent
    // only activates the user. Guard in case provisioning somehow never ran.
    const [wallet] = await this.wallets.findByUserId(user.id);
    if (!wallet) {
      await this.users.update(user.id, { onboarding_step: 'kyc' });
      await this.text(
        user.wa_phone,
        `Let's re-verify your identity first. Please enter your 11-digit *${KYC_LABEL[market]}* (numbers only).`,
      );
      return true;
    }

    await this.users.update(user.id, { status: 'active', onboarding_step: 'done', consent_at: 'now' });
    await this.audit.record({
      userId: user.id,
      action: 'onboarding_completed',
      entity: 'user',
      entityId: user.id,
      metadata: { reference: wallet.reference, currency },
    });

    const symbol = CURRENCY_META[currency].symbol;
    const fundingBlock = wallet.virtual_account_number
      ? `*Fund your wallet* — transfer to:\n` +
        `Bank: ${wallet.virtual_bank_name}\n` +
        `Account: ${wallet.virtual_account_number}\n` +
        `Name: ${user.full_name ?? 'GuildPay user'}\n\n`
      : '';
    await this.text(
      user.wa_phone,
      `🎉 You're all set, ${user.full_name ?? 'there'}!\n\n` +
        `*Your GuildPay wallet*\n` +
        `Reference: ${wallet.reference}\n` +
        `Currency: ${currency}\n` +
        `Balance: ${symbol}0.00\n\n` +
        fundingBlock +
        `You can now fund your wallet, send money, buy airtime and pay bills — just tell me what you need. 💬`,
    );
    return true;
  }

  /** Fallback email if somehow missing (shouldn't happen post-M-email-step). */
  private syntheticEmail(waPhone: string): string {
    return `${waPhone.replace(/\D/g, '')}@wallet.guildpay.ai`;
  }

  // ── prompts / send helpers ──────────────────────────────────────────────────

  private async promptLanguage(to: string): Promise<void> {
    await this.channel.send({
      to,
      kind: 'list',
      body: '👋 Welcome to *GuildPay* — everyday money, made conversational.\n\nChoose your language to get started:',
      buttonTitle: 'Choose language',
      sections: [
        {
          title: 'Select language',
          rows: [
            { id: 'lang_en', title: 'English', description: 'Continue in English' },
            { id: 'lang_pidgin', title: 'Pidgin', description: 'Continue in Nigerian Pidgin' },
            { id: 'lang_ar', title: 'العربية', description: 'المتابعة بالعربية' },
          ],
        },
      ],
    });
  }

  private async promptMarket(to: string, name: string): Promise<void> {
    await this.buttons(to, `Thanks${name ? `, ${name}` : ''}! Which country is your wallet in?`, [
      { id: 'market_ng', title: '🇳🇬 Nigeria (NGN)' },
      { id: 'market_qa', title: '🇶🇦 Qatar (QAR)' },
    ]);
  }

  private async text(to: string, body: string): Promise<void> {
    await this.channel.send({ to, kind: 'text', body });
  }

  private async buttons(to: string, body: string, buttons: { id: string; title: string }[]): Promise<void> {
    await this.channel.send({ to, kind: 'interactive', body, buttons });
  }
}
