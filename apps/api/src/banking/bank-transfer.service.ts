import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import { WhatsappFlowService } from '../channel/whatsapp-flow.service';
import { UsersRepository, type UserRow } from '../database/users.repository';
import { type WalletRow } from '../database/wallets.repository';
import { TransactionsRepository, type TransactionRow } from '../database/transactions.repository';
import { AuditRepository } from '../database/audit.repository';
import { PartnerService } from '../partner/partner.service';
import type { Bank } from '../partner/partner-adapter';
import { WalletService, InsufficientFundsError } from './wallet.service';
import { PinService } from './pin.service';
import { ReceiptService } from './receipt.service';
import { formatMoney } from './money';

const MAX_PIN_ATTEMPTS = 3;

/**
 * Bank transfer (NIP) flow — send to any NGN bank account:
 *   resolve bank → name enquiry → confirm (with resolved name) → PIN → debit + payout → receipt.
 * The AI only prepares; only a verified transaction PIN debits the ledger and calls
 * the partner payout. On a failed payout the debit is reversed; final status is
 * reconciled by transfer.completed.
 */
@Injectable()
export class BankTransferService {
  private readonly logger = new Logger(BankTransferService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly users: UsersRepository,
    private readonly txns: TransactionsRepository,
    private readonly audit: AuditRepository,
    private readonly wallet: WalletService,
    private readonly pins: PinService,
    private readonly partners: PartnerService,
    private readonly receipts: ReceiptService,
    private readonly flows: WhatsappFlowService,
  ) {}

  /** Step 1 — resolve bank + account name, then show the confirmation card. */
  async start(
    user: UserRow,
    wallet: WalletRow,
    amount: number,
    accountNumber: string,
    bankName: string,
  ): Promise<void> {
    const cur = wallet.currency as Currency;
    if (wallet.currency !== 'NGN') {
      return this.send(user, 'Bank transfers are available for NGN wallets only.');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      return this.send(user, 'Please give a valid 10-digit account number.');
    }
    if (amount > Number(wallet.txn_limit)) {
      return this.send(user, `That's above your per-transfer limit of ${formatMoney(cur, wallet.txn_limit)}.`);
    }
    if (amount > Number(wallet.balance)) {
      return this.send(user, `Insufficient balance. You have ${formatMoney(cur, wallet.balance)}.`);
    }

    const adapter = this.partners.forCurrency('NGN');
    let bank: Bank | null;
    try {
      bank = resolveBank(await adapter.listBanks(), bankName);
    } catch (err) {
      this.logger.error(`listBanks failed: ${(err as Error).message}`);
      return this.send(user, "I couldn't load the bank list just now. Please try again in a moment.");
    }
    if (!bank) {
      return this.send(user, `I couldn't identify the bank "${bankName}". Please send the exact bank name.`);
    }

    let accountName: string;
    try {
      accountName = (await adapter.nameEnquiry(accountNumber, bank.code)).accountName;
    } catch {
      return this.send(user, `I couldn't verify ${accountNumber} at ${bank.name}. Double-check the account number and bank.`);
    }

    await this.txns.create({
      walletId: wallet.id,
      type: 'bank_transfer',
      channel: 'text',
      currency: cur,
      amount,
      recipientName: accountName,
      recipientRef: accountNumber,
      bankCode: bank.code,
      status: 'pending_confirmation',
    });
    await this.channel.send({
      to: user.wa_phone,
      kind: 'interactive',
      body:
        `Please confirm this transfer:\n\n` +
        `Amount: *${formatMoney(cur, amount)}*\n` +
        `To: ⚠️ *${accountName}*\n` +
        `Bank: ${bank.name}\n` +
        `Account: ${accountNumber}`,
      buttons: [
        { id: 'txn_confirm', title: 'Confirm ✅' },
        { id: 'txn_cancel', title: 'Cancel' },
      ],
    });
  }

  /** Step 2 — Confirm: ask for the transaction PIN (via secure Flow when available). */
  async confirm(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'pending_otp'); // status name kept for schema compat; gate is the PIN
    // The WhatsApp Flow modal keeps the PIN secure so it never lands in chat.
    // First-time PIN set and non-Meta channels fall back to the chat prompt.
    if (this.channel.name === 'meta' && this.flows.isEnabled()) {
      const cur = txn.currency as Currency;
      const isSetup = !user.pin_hash;
      await this.channel.send(
        this.flows.buildPinFlowMessage(
          user.wa_phone,
          txn.id,
          isSetup
            ? `🔐 You don't have a transaction PIN yet.\nTap *Set PIN* to securely set your 4-digit PIN.`
            : `🔐 Approve your transfer of *${formatMoney(cur, txn.amount)}* to ${txn.recipient_name}.\nTap *Verify Transaction* to enter your PIN securely.`,
          isSetup ? 'Set PIN' : 'Verify Transaction',
        ),
      );
      return;
    }
    await this.send(
      user,
      user.pin_hash
        ? '🔐 Enter your *4-digit transaction PIN* to send the transfer, or type *CANCEL*.'
        : "🔐 You don't have a transaction PIN yet.\nReply with a *new 4-digit PIN* to set it — then I'll ask you to enter it to approve this transfer.",
    );
  }

  async cancel(user: UserRow, txn: TransactionRow): Promise<void> {
    await this.txns.setStatus(txn.id, 'cancelled');
    await this.send(user, 'Transfer cancelled. No money has moved.');
  }

  /** Step 3 — PIN verified: debit the ledger, then call the NIP payout. */
  async submitPin(user: UserRow, wallet: WalletRow, pin: string): Promise<void> {
    const txn = await this.txns.findLatestByStatus(wallet.id, ['pending_otp']);
    if (!txn || txn.type !== 'bank_transfer') {
      await this.send(user, 'That transfer is no longer pending.');
      return;
    }
    if (!(await this.pinGate(user, txn, pin))) return;

    const cur = wallet.currency as Currency;
    const amount = Number(txn.amount);

    // Debit first (holds the funds); reverse on payout failure.
    try {
      await this.wallet.debit(wallet.id, amount, txn.id, 'NIP Transfer Hold', txn.id);
    } catch (err) {
      await this.txns.setStatus(txn.id, 'failed');
      await this.send(
        user,
        err instanceof InsufficientFundsError
          ? 'Insufficient balance — the transfer was not completed.'
          : 'The transfer failed and no money moved.',
      );
      return;
    }

    // ── The payout attempt: the ONLY place a debit may be reversed. ───────────
    let res: { status: 'completed' | 'pending' | 'failed'; raw?: unknown; providerRef?: string };
    try {
      res = await this.partners.forCurrency('NGN').bankTransfer({
        transactionId: txn.id,
        fromAccountRef: wallet.reference,
        accountNumber: txn.recipient_ref!,
        bankCode: txn.bank_code!,
        recipientName: txn.recipient_name ?? '',
        amount,
        narration: 'GuildPay transfer',
      });
      if (res.status === 'failed') {
        const raw = res.raw as { complete_message?: string; message?: string } | undefined;
        throw new Error(raw?.complete_message ?? raw?.message ?? 'payout rejected by the bank');
      }
    } catch (err) {
      // Payout was NOT accepted → reverse the debit; no money left the wallet.
      await this.wallet.credit(wallet.id, amount, txn.id, 'NIP Transfer Refund', txn.id);
      await this.txns.setStatus(txn.id, 'failed');
      const message = (err as Error).message;
      this.logger.error(`bank transfer ${txn.id} payout failed: ${message}`);
      await this.audit.record({
        userId: user.id,
        action: 'bank_transfer_failed',
        entity: 'transaction',
        entityId: txn.id,
        metadata: { reason: payoutReason(message) },
      });
      await this.send(
        user,
        `❌ *Transfer couldn't complete*\n` +
          `Your ${formatMoney(cur, amount)} has been refunded.\n\n` +
          `Reason: ${payoutReason(message)}`,
      );
      return;
    }

    // ── Payout ACCEPTED — money is in flight. From here NOTHING reverses; a
    //    later failure is handled only by the transfer.completed webhook. ──────
    // Real Flutterwave identifiers to propagate onto the receipt (Xara parity).
    const rawTransfer = res.raw as { id?: number | string; reference?: string } | undefined;
    const providerId = rawTransfer?.id != null ? String(rawTransfer.id) : undefined;
    const providerRef = rawTransfer?.reference ?? res.providerRef ?? undefined;

    const completed = res.status === 'completed';
    await this.txns.setStatus(txn.id, completed ? 'completed' : 'processing');
    await this.audit.record({
      userId: user.id,
      action: 'bank_transfer_initiated',
      entity: 'transaction',
      entityId: txn.id,
      metadata: { amount, bankCode: txn.bank_code, providerId },
    });
    try {
      const newBalance = await this.wallet.getBalance(wallet.id);
      await this.send(
        user,
        `${completed ? '✅ *Transfer successful*' : '⏳ *Transfer processing*'}\n\n` +
          `Amount: ${formatMoney(cur, amount)}\n` +
          `To: ${txn.recipient_name}\n` +
          `Account: ${txn.recipient_ref}\n` +
          `Ref: ${providerRef ?? txn.id.slice(0, 8).toUpperCase()}\n\n` +
          `Your new balance is *${formatMoney(cur, newBalance)}*.`,
      );
      await this.sendReceipt(user, wallet, txn, amount, completed, providerRef, providerId);
      await this.channel.send({
        to: user.wa_phone,
        kind: 'interactive',
        body: `Save *${txn.recipient_name}* as a beneficiary?`,
        buttons: [
          { id: 'bene_save', title: 'Save ✅' },
          { id: 'bene_no', title: 'No thanks' },
        ],
      });
    } catch (err) {
      // Post-payout messaging is best-effort — the money already moved.
      this.logger.warn(`post-payout notify failed for ${txn.id}: ${(err as Error).message}`);
    }
  }

  /**
   * The PIN gate — the ONLY path to money movement. First-time users set their
   * PIN here (hashed; raw PIN never stored/logged), then must enter it again.
   * 3 wrong attempts cancel the transaction.
   */
  private async pinGate(user: UserRow, txn: TransactionRow, pin: string): Promise<boolean> {
    if (!this.pins.isValidFormat(pin)) {
      await this.send(user, 'Your PIN is *4 digits*. Try again, or type *CANCEL*.');
      return false;
    }
    if (!user.pin_hash) {
      const pinHash = this.pins.hash(pin);
      await this.users.update(user.id, { pin_hash: pinHash });
      await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_set', entity: 'user', entityId: user.id });
      await this.send(user, '✅ PIN saved.');
      await this.confirm({ ...user, pin_hash: pinHash }, txn);
      return false; // must enter it again — setting a PIN never approves money
    }
    if (!this.pins.verify(pin, user.pin_hash)) {
      await this.audit.record({ userId: user.id, actor: 'user', action: 'pin_failed', entity: 'transaction', entityId: txn.id });
      const fails = await this.audit.countByEntityAction(txn.id, 'pin_failed');
      if (fails >= MAX_PIN_ATTEMPTS) {
        await this.txns.setStatus(txn.id, 'cancelled');
        await this.send(user, '❌ Too many wrong attempts — the transfer was cancelled. No money moved.');
      } else {
        await this.send(user, `Incorrect PIN (${fails}/${MAX_PIN_ATTEMPTS}). Try again, or type *CANCEL*.`);
      }
      return false;
    }
    return true;
  }

  /** Render + send the GuildPay-branded receipt image. Best-effort (never blocks the flow). */
  private async sendReceipt(
    user: UserRow,
    wallet: WalletRow,
    txn: TransactionRow,
    amount: number,
    completed: boolean,
    providerRef?: string,
    providerId?: string,
  ): Promise<void> {
    try {
      let bankName: string | undefined;
      if (txn.bank_code) {
        try {
          const banks = await this.partners.forCurrency('NGN').listBanks();
          bankName = banks.find((b) => b.code === txn.bank_code)?.name;
        } catch {
          /* bank name is optional on the receipt */
        }
      }
      const png = this.receipts.render({
        status: completed ? 'COMPLETED' : 'PROCESSING',
        currency: wallet.currency as Currency,
        amount,
        sender: user.full_name ?? 'GuildPay user',
        recipient: txn.recipient_name ?? txn.recipient_ref ?? '—',
        bank: bankName,
        account: txn.recipient_ref ?? undefined,
        reference: txn.id.slice(0, 8).toUpperCase(),
        providerRef, // full Flutterwave reference — shown as "Reference" when present
        providerId, // Flutterwave transaction id — shown as a separate "ID" row
        date: new Date(txn.created_at),
      });
      await this.channel.send({
        to: user.wa_phone,
        kind: 'image',
        image: png,
        caption: `${completed ? 'Transfer complete' : 'Transfer processing'} — ${formatMoney(wallet.currency as Currency, amount)}`,
      });
    } catch (err) {
      this.logger.warn(`receipt render/send failed: ${(err as Error).message}`);
    }
  }

  private async send(user: UserRow, body: string): Promise<void> {
    await this.channel.send({ to: user.wa_phone, kind: 'text', body });
  }
}

/**
 * Turn a raw payout error into a user-facing reason. Strips our internal
 * "Flutterwave POST /transfers failed:" wrapper and adds a short hint for the
 * common account gates so the failure is self-diagnosing from the chat.
 */
export function payoutReason(message: string): string {
  const raw = message.replace(/^Flutterwave\s+[A-Z]+\s+\S+\s+failed:\s*/i, '').trim() || 'Unknown error';
  const lower = raw.toLowerCase();
  if (lower.includes('not enabled to make transfers')) {
    return `${raw}\n(Enable API transfers: Flutterwave → Settings → Business Preferences → Security.)`;
  }
  if (lower.includes('ip whitelist')) {
    return `${raw}\n(Whitelist the server IP in Flutterwave settings.)`;
  }
  if (lower.includes('insufficient') && lower.includes('balance')) {
    return `${raw}\n(Fund your Flutterwave merchant balance.)`;
  }
  return raw;
}

/** Generic words that carry no disambiguating signal in a Nigerian bank name. */
const GENERIC_BANK_TOKENS = new Set([
  'bank', 'plc', 'ltd', 'limited', 'the', 'nigeria', 'nig', 'company', 'co',
]);

/**
 * Common abbreviations → their canonical name text. The /banks/NG list uses full
 * legal names ("Guaranty Trust Bank", "United Bank for Africa"), but users and
 * Flutterwave virtual accounts use short forms ("GTBank", "UBA"). Applied to both
 * sides symmetrically, so matching stays consistent regardless of which form each
 * uses. Word-boundary anchored to avoid mangling unrelated names.
 */
const BANK_ALIASES: Array<[RegExp, string]> = [
  [/\bgt\s*bank\b/g, 'guaranty trust'],
  [/\bgtb\b/g, 'guaranty trust'],
  [/\buba\b/g, 'united bank for africa'],
  [/\bfcmb\b/g, 'first city monument bank'],
  [/\b(?:fbn|firstbank)\b/g, 'first bank'],
];

/**
 * Normalize a bank name into significant lowercase tokens. Critically, it expands
 * the "MFB" ⇄ "microfinance bank" abbreviation and drops generic words, so
 * Flutterwave's two spellings of the same bank — e.g. "Indulge MFB" on a virtual
 * account vs "INDULGE MICROFINANCE BANK" in /banks/NG — tokenize identically.
 */
function bankTokens(name: string): string[] {
  let s = name.toLowerCase().replace(/&/g, ' and ');
  for (const [pattern, canonical] of BANK_ALIASES) s = s.replace(pattern, canonical);
  return s
    .replace(/\bmfb\b/g, ' microfinance bank ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !GENERIC_BANK_TOKENS.has(t));
}

/**
 * Resolve a free-text bank name to a single Bank from the NIP list, or null if
 * none/ambiguous. Matches on normalized token *sets* rather than raw substrings,
 * because Flutterwave names the same bank inconsistently ("Indulge MFB" vs
 * "INDULGE MICROFINANCE BANK") — a substring match misses it entirely. Prefers a
 * full token-set match, then the tightest superset; returns null only when the
 * query is empty or there is no confident, unambiguous winner.
 */
export function resolveBank(banks: Bank[], query: string): Bank | null {
  const q = bankTokens(query);
  if (q.length === 0) return null;

  let best: Bank | null = null;
  let bestScore = -Infinity;
  let runnerUpScore = -Infinity;

  for (const b of banks) {
    const t = bankTokens(b.name);
    if (t.length === 0) continue;

    const shared = q.filter((x) => t.includes(x)).length;
    if (shared === 0) continue;

    const queryInsideBank = q.every((x) => t.includes(x));
    const bankInsideQuery = t.every((x) => q.includes(x));
    // Require one set to fully contain the other — a loose partial overlap
    // (e.g. sharing only "microfinance") is not a confident match.
    if (!queryInsideBank && !bankInsideQuery) continue;

    const exactSet = queryInsideBank && bankInsideQuery ? 1 : 0;
    const extraTokens = Math.abs(t.length - q.length);
    const score = exactSet * 1000 + shared * 10 - extraTokens;

    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      best = b;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }

  // Only return on a strict, unambiguous winner.
  return best && bestScore > runnerUpScore ? best : null;
}
