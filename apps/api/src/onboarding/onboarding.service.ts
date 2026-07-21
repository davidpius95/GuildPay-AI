import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CURRENCY_META, type Currency, type InboundMessage, type Market } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { WhatsappFlowService } from '../channel/whatsapp-flow.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository } from '../database/wallets.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type {
  CreateVirtualAccountResult,
  IdentityVerificationResult,
} from '../partner/partner-adapter';
import { PinService } from '../banking/pin.service';

const MARKET_CURRENCY: Record<Market, Currency> = { NG: 'NGN', QA: 'QAR' };
const KYC_LABEL: Record<Market, string> = { NG: 'BVN', QA: 'QID' };

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
      await this.promptLanguage(msg.waPhone);
      return true;
    }

    switch (user.onboarding_step) {
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
      case 'kyc_pending':
        return this.stepKycPending(user, msg);
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
   * KYC entry point. Validates the 11-digit ID, then branches by rail:
   *   - NGN → start Flutterwave's BVN *consent* flow. The user approves with their
   *     bank via a secure link; the NUBAN is provisioned only after the
   *     `bvn.verification.completed` webhook confirms consent (see completeBvnConsent).
   *   - QAR → resolve the (simulated) QID synchronously and provision immediately.
   * No wallet or account number is created until identity is confirmed.
   */
  private async stepKyc(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const market = (user.market ?? 'NG') as Market;
    const currency = MARKET_CURRENCY[market];
    const kyc = (msg.text ?? '').replace(/\s/g, '');
    if (!/^\d{11}$/.test(kyc)) {
      await this.text(
        user.wa_phone,
        `That doesn't look right — please enter your 11-digit *${KYC_LABEL[market]}* (numbers only).`,
      );
      return true;
    }

    if (currency === 'NGN') {
      return this.startBvnConsent(user, kyc);
    }
    // QAR (simulated QID) resolves synchronously on the mock rail.
    return this.provisionWalletAndAdvance(user, market, kyc);
  }

  /**
   * Start Flutterwave's BVN consent verification: send the user a secure link to
   * approve with their bank, store the provider reference (to correlate the
   * webhook) and the BVN (needed to provision the NUBAN after consent), and park
   * the user in `kyc_pending`. The raw BVN is never logged.
   */
  private async startBvnConsent(user: UserRow, bvn: string): Promise<boolean> {
    const firstName = user.first_name ?? (user.full_name ?? '').trim().split(/\s+/)[0];
    const lastName = user.last_name ?? firstName;
    let result: IdentityVerificationResult;
    try {
      result = await this.partners.forCurrency('NGN').verifyIdentity({
        type: 'bvn',
        idNumber: bvn,
        firstName: firstName || undefined,
        lastName: lastName || firstName || undefined,
      });
    } catch (err) {
      this.logger.warn(`BVN consent start failed for user ${user.id}: ${(err as Error).message}`);
      await this.text(
        user.wa_phone,
        "⚠️ I couldn't start BVN verification just now. Please send your 11-digit *BVN* again in a moment.",
      );
      return true; // stay on the kyc step
    }

    if (result.status === 'failed' || !result.consentUrl || !result.reference) {
      await this.users.update(user.id, { kyc_status: 'failed' });
      await this.audit.record({
        userId: user.id,
        action: 'kyc_failed',
        entity: 'user',
        entityId: user.id,
        metadata: { type: 'bvn' },
      });
      await this.text(
        user.wa_phone,
        `❌ I couldn't verify that BVN.\n\n` +
          `Please double-check the 11 digits and send your *BVN* again (numbers only).`,
      );
      return true;
    }

    await this.users.update(user.id, {
      kyc_id: bvn,
      kyc_status: 'pending',
      kyc_reference: result.reference,
      onboarding_step: 'kyc_pending',
    });
    await this.audit.record({
      userId: user.id,
      action: 'kyc_pending',
      entity: 'user',
      entityId: user.id,
      metadata: { type: 'bvn', reference: result.reference }, // no raw BVN
    });

    await this.text(
      user.wa_phone,
      `🔐 *Verify your BVN*\n\n` +
        `Tap the secure link below to confirm your identity with your bank. ` +
        `It takes about a minute, and I'll set up your wallet automatically once you're done:\n\n` +
        `${result.consentUrl}\n\n` +
        `_Verification happens directly with your bank — GuildPay never sees your bank password or PIN._`,
    );
    return true;
  }

  /**
   * The user sent a message while we're waiting for their bank to confirm BVN
   * consent. Resending an 11-digit BVN restarts verification; anything else gets a
   * gentle "still waiting" nudge.
   */
  private async stepKycPending(user: UserRow, msg: InboundMessage): Promise<boolean> {
    const market = (user.market ?? 'NG') as Market;
    const digits = (msg.text ?? '').replace(/\s/g, '');
    if (/^\d{11}$/.test(digits)) {
      return this.startBvnConsent(user, digits);
    }
    await this.text(
      user.wa_phone,
      `⏳ I'm still waiting for your *BVN* verification to complete with your bank.\n\n` +
        `Please finish the secure link I sent — I'll set up your wallet automatically once it's done. ` +
        `To start over, send your 11-digit *${KYC_LABEL[market]}* again.`,
    );
    return true;
  }

  /**
   * Called from the Flutterwave webhook when a BVN consent verification completes.
   * `result` is the authoritative status re-read from Flutterwave (never the raw
   * webhook body). On success we provision the NUBAN and advance to the PIN step;
   * on failure the user drops back to the KYC step to retry. Idempotent: only acts
   * while the user is still in `kyc_pending`.
   */
  async completeBvnConsent(reference: string, result: IdentityVerificationResult): Promise<void> {
    const user = await this.users.findByKycReference(reference);
    if (!user) {
      this.logger.warn(`BVN consent webhook: no user for reference ${reference}`);
      return;
    }
    if (user.onboarding_step !== 'kyc_pending') {
      this.logger.log(
        `BVN consent webhook: user ${user.id} not awaiting consent (step=${user.onboarding_step}) — ignored`,
      );
      return; // already processed or the user moved on
    }
    const market = (user.market ?? 'NG') as Market;

    if (result.status !== 'verified') {
      await this.users.update(user.id, {
        kyc_status: 'failed',
        kyc_reference: null,
        onboarding_step: 'kyc',
      });
      await this.audit.record({
        userId: user.id,
        action: 'kyc_failed',
        entity: 'user',
        entityId: user.id,
        metadata: { type: 'bvn', reference },
      });
      await this.text(
        user.wa_phone,
        `❌ Your BVN verification didn't go through.\n\n` +
          `Please send your 11-digit *BVN* again (numbers only) to try once more.`,
      );
      return;
    }

    const bvn = user.kyc_id;
    if (!bvn) {
      // We stored the BVN when starting consent, so this shouldn't happen.
      await this.users.update(user.id, { kyc_reference: null, onboarding_step: 'kyc' });
      await this.text(
        user.wa_phone,
        `Let's try that again — please send your 11-digit *${KYC_LABEL[market]}* (numbers only).`,
      );
      return;
    }
    await this.users.update(user.id, { kyc_reference: null });
    await this.provisionWalletAndAdvance(user, market, bvn);
  }

  /**
   * Provision the wallet + funding account for a verified identity and advance to
   * the PIN step. Shared by the QAR synchronous path and the NGN post-consent
   * webhook. Never logs/audits the full account number or ID.
   */
  private async provisionWalletAndAdvance(
    user: UserRow,
    market: Market,
    kyc: string,
  ): Promise<boolean> {
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
      this.logger.warn(`Account provisioning failed for user ${user.id}: ${(err as Error).message}`);
      await this.users.update(user.id, { kyc_status: 'failed', onboarding_step: 'kyc' });
      await this.audit.record({
        userId: user.id,
        action: 'kyc_failed',
        entity: 'user',
        entityId: user.id,
        metadata: { type: KYC_LABEL[market].toLowerCase() },
      });
      await this.text(
        user.wa_phone,
        `❌ I couldn't finish setting up your account. Please send your *${KYC_LABEL[market]}* again (numbers only).`,
      );
      return true;
    }

    const wallet = await this.wallets.create({ userId: user.id, reference, currency, market });
    await this.wallets.setVirtualAccount(
      wallet.id,
      account.accountNumber,
      account.bankName,
      account.providerRef,
    );
    await this.users.update(user.id, { kyc_id: kyc, kyc_status: 'verified', onboarding_step: 'pin' });
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
    await this.sendPinPrompt(user, market);
    return true;
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
