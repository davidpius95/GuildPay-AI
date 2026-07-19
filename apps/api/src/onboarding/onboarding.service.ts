import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CURRENCY_META, type Currency, type InboundMessage, type Market } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { WalletsRepository } from '../database/wallets.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type { CreateVirtualAccountResult } from '../partner/partner-adapter';
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
   * Verify the government ID with the rail BEFORE advancing. For NGN this
   * provisions the permanent NUBAN, which makes Flutterwave validate the BVN and
   * reject a mismatch — so a wrong/invalid BVN cannot pass this step. On failure
   * we stay on the KYC step and re-prompt; no wallet or account number is created.
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
      // Rail rejected the ID (e.g. BVN mismatch). Never log the raw ID.
      this.logger.warn(`KYC verification failed for user ${user.id}: ${(err as Error).message}`);
      await this.users.update(user.id, { kyc_status: 'failed' });
      await this.audit.record({
        userId: user.id,
        action: 'kyc_failed',
        entity: 'user',
        entityId: user.id,
        metadata: { type: KYC_LABEL[market].toLowerCase() },
      });
      await this.text(
        user.wa_phone,
        `❌ I couldn't verify that ${KYC_LABEL[market]} with your bank.\n\n` +
          `Please double-check the 11 digits and send your *${KYC_LABEL[market]}* again (numbers only).`,
      );
      return true; // stay on the KYC step — do not advance
    }

    // Verified → create the wallet and attach its funding account now.
    const wallet = await this.wallets.create({ userId: user.id, reference, currency, market });
    await this.wallets.setVirtualAccount(
      wallet.id,
      account.accountNumber,
      account.bankName,
      account.providerRef,
    );
    await this.users.update(user.id, { kyc_id: kyc, kyc_status: 'verified', onboarding_step: 'pin' });
    // Never log/audit the full account number or BVN.
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

    await this.text(
      user.wa_phone,
      `✅ ${KYC_LABEL[market]} verified.\n\n` +
        '🔐 Now set your *4-digit transaction PIN* (numbers only).\n\n' +
        "You'll enter this PIN to approve every transfer, so keep it secret. " +
        'You can delete your message after I confirm it.',
    );
    return true;
  }

  /** Set the 4-digit transaction PIN (hashed; the raw PIN is never stored or logged). */
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
