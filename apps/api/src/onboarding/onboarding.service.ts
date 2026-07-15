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
    await this.users.update(user.id, { kyc_id: kyc, onboarding_step: 'pin' });
    await this.text(
      user.wa_phone,
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
    const reference = `GPA-${market}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const wallet = await this.wallets.create({ userId: user.id, reference, currency, market });
    await this.users.update(user.id, { status: 'active', onboarding_step: 'done', consent_at: 'now' });
    await this.audit.record({
      userId: user.id,
      action: 'wallet_created',
      entity: 'wallet',
      entityId: wallet.id,
      metadata: { reference, currency },
    });

    // Provision the account the user funds into via the currency's partner rail
    // (NGN → real NUBAN; QAR → simulated). Non-blocking: onboarding still completes
    // if provisioning fails — the user can fund later.
    const virtualAccount = await this.provisionAccount(user, wallet.id, reference, currency);

    const symbol = CURRENCY_META[currency].symbol;
    const fundingBlock = virtualAccount
      ? `*Fund your wallet* — transfer to:\n` +
        `Bank: ${virtualAccount.bankName}\n` +
        `Account: ${virtualAccount.accountNumber}\n` +
        `Name: ${user.full_name ?? 'GuildPay user'}\n\n`
      : '';
    await this.text(
      user.wa_phone,
      `🎉 You're all set, ${user.full_name ?? 'there'}!\n\n` +
        `*Your GuildPay wallet*\n` +
        `Reference: ${reference}\n` +
        `Currency: ${currency}\n` +
        `Balance: ${symbol}0.00\n\n` +
        fundingBlock +
        `You can now fund your wallet, send money, buy airtime and pay bills — just tell me what you need. 💬`,
    );
    return true;
  }

  /** Create + persist the funding account (NGN NUBAN / QAR simulated). Never blocks onboarding. */
  private async provisionAccount(
    user: UserRow,
    walletId: string,
    reference: string,
    currency: Currency,
  ): Promise<CreateVirtualAccountResult | null> {
    const firstName = user.first_name ?? (user.full_name ?? '').trim().split(/\s+/)[0];
    const lastName = user.last_name ?? firstName;
    try {
      const account = await this.partners.forCurrency(currency).createVirtualAccount({
        userRef: reference,
        email: user.email ?? this.syntheticEmail(user.wa_phone),
        firstName: firstName || undefined,
        lastName: lastName || firstName || undefined,
        phone: user.wa_phone,
        bvn: user.kyc_id ?? undefined,
      });
      await this.wallets.setVirtualAccount(walletId, account.accountNumber, account.bankName, account.providerRef);
      // BVN was accepted by the rail at account creation → mark KYC verified.
      await this.users.update(user.id, { kyc_status: 'verified' });
      // Never log/audit the full account number or BVN.
      await this.audit.record({
        userId: user.id,
        action: 'virtual_account_created',
        entity: 'wallet',
        entityId: walletId,
        metadata: { bank: account.bankName },
      });
      return account;
    } catch (err) {
      this.logger.error(`account provisioning failed for wallet ${walletId}: ${(err as Error).message}`);
      await this.users.update(user.id, { kyc_status: 'failed' });
      await this.audit.record({
        userId: user.id,
        action: 'virtual_account_failed',
        entity: 'wallet',
        entityId: walletId,
      });
      return null;
    }
  }

  /** Fallback email if somehow missing (shouldn't happen post-M-email-step). */
  private syntheticEmail(waPhone: string): string {
    return `${waPhone.replace(/\D/g, '')}@wallet.guildpay.ai`;
  }

  // ── prompts / send helpers ──────────────────────────────────────────────────

  private async promptLanguage(to: string): Promise<void> {
    await this.buttons(
      to,
      '👋 Welcome to *GuildPay* — your money, right inside WhatsApp.\n\nWhich language would you like to use?',
      [
        { id: 'lang_en', title: 'English' },
        { id: 'lang_pidgin', title: 'Pidgin' },
        { id: 'lang_ar', title: 'العربية' },
      ],
    );
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
