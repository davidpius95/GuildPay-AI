import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import type { Currency } from '@guildpay/shared';
import { formatMoney } from './money';
import { LOGO_BASE64 } from './logo';

export interface ReceiptData {
  status: 'COMPLETED' | 'PROCESSING';
  currency: Currency;
  amount: number;
  sender: string;
  recipient: string;
  bank?: string;
  account?: string;
  /** Fallback reference (internal) — shown only when providerRef is absent. */
  reference: string;
  /** Full provider (Flutterwave) transaction reference, e.g. "TRF927769...". Preferred. */
  providerRef?: string;
  /** Provider (Flutterwave) numeric transaction id — rendered as a separate "ID" row. */
  providerId?: string;
  /** Optional fee/transparency line, e.g. "Fee covered by your 30 free transfers/month". */
  feeNote?: string;
  date?: Date;
}

// WhatsApp-inspired palette.
const GREEN = '#25D366'; // WhatsApp accent green (pill + accents)
const GREEN_DEEP = '#0A7C42'; // readable green for the amount on white
const INK = '#0b141a';
const MUTED = '#667781';
const LINE = '#e7ebee';
const BG = '#e9edf0';

/** Font family used in the SVG markup. Must match the family name inside the TTF files. */
const FONT = 'Inter';

/**
 * Bundled font files resolved relative to the compiled JS output.
 * NestJS copies these from src/banking/fonts/ → dist/banking/fonts/ via the
 * "assets" config in nest-cli.json, so __dirname always reaches them.
 */
const FONT_DIR = join(__dirname, 'fonts');
const FONT_FILES = [
  join(FONT_DIR, 'Inter-Regular.ttf'),   // weight 400
  join(FONT_DIR, 'Inter-Bold.ttf'),       // weight 700
  join(FONT_DIR, 'Inter-ExtraBold.ttf'),  // weight 800
];

/**
 * Renders a GuildPay-branded transaction receipt (WhatsApp green) as a PNG,
 * so it can be sent back to the user as a WhatsApp image. SVG → PNG via resvg.
 *
 * Fonts are BUNDLED with the app (Inter TTFs) so rendering is identical across
 * macOS dev, CI, and Docker production — no system fonts required.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);

  render(data: ReceiptData): Buffer {
    const svg = this.svg(data);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 760 },
      font: {
        loadSystemFonts: false,
        fontFiles: FONT_FILES,
        defaultFontFamily: FONT,
      },
      background: BG,
    });
    return Buffer.from(resvg.render().asPng());
  }

  private svg(d: ReceiptData): string {
    const amount = formatMoney(d.currency, d.amount);
    const when = fmtDate(d.date ?? new Date());
    const statusColor = d.status === 'COMPLETED' ? GREEN : '#E0A13A';

    const rows: Array<[string, string]> = [['Sender', d.sender], ['Recipient', d.recipient]];
    if (d.bank) rows.push(['Recipient Bank', d.bank]);
    if (d.account) rows.push(['Recipient Account', d.account]);
    // Prefer the full provider (Flutterwave) reference; fall back to the internal one.
    rows.push(['Reference', d.providerRef ?? d.reference]);
    if (d.providerId) rows.push(['ID', d.providerId]);

    let y = 396;
    const rowSvg = rows
      .map(([label, value]) => {
        // Long values (Flutterwave refs/ids ~24 chars) render full at a smaller
        // size so they aren't truncated; short values keep the larger, clipped style.
        const long = value.length > 20;
        const size = long ? 15 : 20;
        const shown = long ? value : clip(value, 26);
        const block =
          `<text x="72" y="${y}" font-family="${FONT}" font-size="20" fill="${MUTED}">${esc(label)}</text>` +
          `<text x="688" y="${y}" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="${size}" fill="${INK}">${esc(shown)}</text>` +
          `<line x1="72" y1="${y + 22}" x2="688" y2="${y + 22}" stroke="${LINE}" stroke-width="1.5" stroke-dasharray="2 5"/>`;
        y += 56;
        return block;
      })
      .join('');

    const footerY = y + 40;
    const height = footerY + 160; // footer block (160) + bottom margin

    return `<svg width="760" height="${height}" viewBox="0 0 760 ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="760" height="${height}" fill="${BG}"/>
  
  <!-- Main Card includes footer -->
  <rect x="40" y="40" width="680" height="${height - 80}" rx="28" fill="#ffffff"/>
  
  <!-- Main Watermark (in the recipient/reference rows area) -->
  <image href="${LOGO_BASE64}" x="80" y="464" width="600" height="200" preserveAspectRatio="xMidYMid meet" opacity="0.12" />

  <!-- Footer Watermark -->
  <image href="${LOGO_BASE64}" x="80" y="${footerY - 10}" width="600" height="200" preserveAspectRatio="xMidYMid meet" opacity="0.12" />

  <!-- header -->
  <image href="${LOGO_BASE64}" x="72" y="80" width="220" height="60" preserveAspectRatio="xMidYMid meet" />
  <rect x="512" y="88" width="176" height="42" rx="21" fill="${statusColor}"/>
  <text x="600" y="116" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="18" fill="#ffffff">${d.status}</text>

  <!-- amount -->
  <text x="380" y="248" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="76" fill="${GREEN_DEEP}">${esc(amount)}</text>
  <text x="380" y="290" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${MUTED}">${esc(when)}</text>
  ${d.feeNote ? `<text x="380" y="318" text-anchor="middle" font-family="${FONT}" font-size="16" fill="${GREEN_DEEP}">${esc(clip(d.feeNote, 46))}</text>` : ''}

  <line x1="72" y1="340" x2="688" y2="340" stroke="${LINE}" stroke-width="2"/>

  <!-- rows -->
  ${rowSvg}

  <!-- footer -->
  <line x1="72" y1="${footerY}" x2="688" y2="${footerY}" stroke="${LINE}" stroke-width="2" stroke-dasharray="6 6"/>
  <image href="${LOGO_BASE64}" x="280" y="${footerY + 24}" width="200" height="40" preserveAspectRatio="xMidYMid meet" />
  <text x="380" y="${footerY + 90}" text-anchor="middle" font-family="${FONT}" font-size="16" font-weight="700" fill="${GREEN_DEEP}">guildpay.ai</text>
  <text x="380" y="${footerY + 116}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${MUTED}">Generated on ${esc(when)}</text>
</svg>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12;
  return `${months[d.getMonth()]} ${p(d.getDate())}, ${d.getFullYear()} at ${p(h)}:${p(d.getMinutes())} ${ampm}`;
}

