import { CURRENCY_META, type Currency } from '@guildpay/shared';
import { formatMoney } from '../banking/money';
import type {
  Dispute,
  IdentityVerificationResult,
  MerchantBalance,
  Settlement,
} from '../partner/partner-adapter';

/**
 * chat-templates — the single home for Xara-style WhatsApp message formatting.
 *
 * WhatsApp text supports a small markdown set: *bold*, _italic_, ~strike~,
 * ```monospace```. These builders keep every card visually consistent (title
 * rule, labeled rows, footer hint) so capability modules never hand-assemble a
 * card. Pure functions: they format, they never send, log, or move money.
 *
 * PII rule: builders that take a raw id (BVN/NIN, account/QID) MUST mask it —
 * see `maskId`. Never pass an unmasked government id into a card body.
 */

const RULE = '━━━━━━━━━━━━━━━';

/** A single "Label: value" row; omitted entirely when the value is empty. */
export interface Row {
  label: string;
  value: string | number | null | undefined;
  /** Render the value in *bold* (e.g. the headline amount). */
  strong?: boolean;
  /** Leading emoji/icon for the row. */
  icon?: string;
}

/**
 * Generic card: an emoji/title header, a divider, then aligned rows, with an
 * optional footer hint. This is the primitive every specific card builds on.
 */
export function card(opts: {
  icon?: string;
  title: string;
  rows: Row[];
  footer?: string;
}): string {
  const head = `${opts.icon ? `${opts.icon} ` : ''}*${opts.title}*`;
  const lines = opts.rows
    .filter((r) => r.value !== null && r.value !== undefined && String(r.value).trim() !== '')
    .map((r) => {
      const val = r.strong ? `*${r.value}*` : `${r.value}`;
      return `${r.icon ? `${r.icon} ` : ''}${r.label}: ${val}`;
    });
  const body = [head, RULE, ...lines].join('\n');
  return opts.footer ? `${body}\n\n_${opts.footer}_` : body;
}

/** Mask a government id / account number, showing only the last 4 (e.g. •••••••4321). */
export function maskId(id: string | null | undefined): string {
  const s = (id ?? '').replace(/\s/g, '');
  if (s.length <= 4) return s ? '••••' : '—';
  return `${'•'.repeat(Math.max(3, s.length - 4))}${s.slice(-4)}`;
}

// ── Identity / KYC ───────────────────────────────────────────────────────────

/**
 * KYC result card for the user chat. `idNumber` is masked here — pass the raw
 * value; this function never reveals more than the last 4 digits.
 */
export function kycResultCard(
  result: IdentityVerificationResult,
  idNumber: string,
): string {
  const label = result.type.toUpperCase();
  if (result.status === 'verified') {
    return card({
      icon: '✅',
      title: 'Identity verified',
      rows: [
        { label: 'Type', value: label },
        { label: 'ID', value: maskId(idNumber) },
        { label: 'Name', value: result.name },
        { label: 'Reference', value: result.reference },
      ],
      footer: "You're all set — you can use every GuildPay feature.",
    });
  }
  if (result.status === 'pending') {
    return card({
      icon: '⏳',
      title: 'Verification in progress',
      rows: [
        { label: 'Type', value: label },
        { label: 'ID', value: maskId(idNumber) },
        { label: 'Next step', value: result.consentUrl ? 'Tap the link to give consent' : 'Awaiting confirmation' },
        { label: 'Link', value: result.consentUrl },
      ],
      footer: "I'll let you know the moment it's confirmed.",
    });
  }
  return card({
    icon: '⚠️',
    title: "Couldn't verify that ID",
    rows: [
      { label: 'Type', value: label },
      { label: 'ID', value: maskId(idNumber) },
      { label: 'Reason', value: result.message ?? 'Details did not match' },
    ],
    footer: 'Please check the number and try again.',
  });
}

// ── Merchant operations (used by admin surfaces that render as chat/text) ─────

/** Merchant float across settlement currencies. */
export function balancesCard(balances: MerchantBalance[]): string {
  if (balances.length === 0) {
    return card({ icon: '🏦', title: 'Merchant balances', rows: [], footer: 'No balances to show.' });
  }
  const rows: Row[] = balances.map((b) => ({
    label: b.currency,
    value: `${fmt(b.currency, b.availableBalance)} avail · ${fmt(b.currency, b.ledgerBalance)} ledger`,
  }));
  return card({ icon: '🏦', title: 'Merchant float balance', rows, footer: 'Available = withdrawable now.' });
}

/** One settlement's detail. */
export function settlementCard(s: Settlement): string {
  return card({
    icon: '💸',
    title: `Settlement ${s.id}`,
    rows: [
      { label: 'Status', value: titleCase(s.status) },
      { label: 'Net', value: fmt(s.currency, s.netAmount), strong: true },
      { label: 'Gross', value: fmt(s.currency, s.grossAmount) },
      { label: 'Fees', value: fmt(s.currency, s.appFee + s.merchantFee) },
      { label: 'Settles', value: formatDate(s.dueDate) },
      { label: 'To', value: s.bankName ? `${s.bankName} ${maskId(s.accountNumber)}` : undefined },
    ],
  });
}

/** One dispute/chargeback's detail. */
export function disputeCard(d: Dispute): string {
  return card({
    icon: '⚖️',
    title: `Dispute ${d.id}`,
    rows: [
      { label: 'Status', value: titleCase(d.status) },
      { label: 'Amount', value: fmt(d.currency, d.amount), strong: true },
      { label: 'Reason', value: d.reason },
      { label: 'Customer', value: d.customerEmail },
      { label: 'Respond by', value: formatDate(d.dueDate) },
      { label: 'Charge ref', value: d.txRef },
    ],
    footer: d.status.toLowerCase() === 'pending' ? 'Action needed — respond before the deadline.' : undefined,
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Money format that tolerates unknown provider currencies (falls back to the code). */
function fmt(currency: string, amount: number): string {
  if (currency in CURRENCY_META) return formatMoney(currency as Currency, amount);
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString().replace(' GMT', '');
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
