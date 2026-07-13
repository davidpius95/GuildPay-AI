import { CURRENCY_META, type Currency } from '@guildpay/shared';

/** Format a money amount for display, e.g. formatMoney('NGN', '2000') → "₦2,000.00". */
export function formatMoney(currency: Currency, amount: string | number): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  const pretty = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${CURRENCY_META[currency].symbol}${pretty}`;
}

/** Candidate wa_phone forms so "08031234567" can match a stored "2348031234567". */
export function phoneCandidates(input: string, market: string | null): string[] {
  const digits = input.replace(/\D/g, '');
  const cc = market === 'QA' ? '974' : '234';
  const out = new Set<string>([digits]);
  if (digits.startsWith('0')) out.add(cc + digits.slice(1));
  if (!digits.startsWith(cc)) out.add(cc + digits);
  return [...out];
}
