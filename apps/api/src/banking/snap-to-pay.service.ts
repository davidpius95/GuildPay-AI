import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Currency } from '@guildpay/shared';
import { CHANNEL_ADAPTER } from '../channel/channel.module';
import type { ChannelAdapter } from '../channel/channel-adapter';
import type { UserRow } from '../database/users.repository';
import type { WalletRow } from '../database/wallets.repository';
import { AiService } from '../ai/ai.service';
import { BankTransferService } from './bank-transfer.service';
import { formatMoney } from './money';

/** Validated shape of what vision extracts from a payment image. */
const SnapSchema = z.object({
  accountNumber: z.string().nullable().default(null),
  bankName: z.string().min(1).nullable().default(null),
  amount: z.number().positive().nullable().default(null),
});
type Snap = z.infer<typeof SnapSchema>;

const SYSTEM = `You read Nigerian bank payment details from an image (an account slip, invoice, POS/QR, or note).
Output ONLY a JSON object (no prose, no markdown) with keys:
- "accountNumber": the payee's 10-digit bank account number as a string, or null if not clearly visible.
- "bankName": the payee's bank name, or null.
- "amount": the amount to pay as a number, or null if not stated.
NEVER invent a value — use null when it is not clearly visible in the image.`;

/**
 * Snap-to-pay — a photo of bank details / an invoice becomes a prefilled bank transfer.
 * Vision only PREPARES: it fills the transfer form; the normal OTP gate still applies
 * (it routes into BankTransferService, which name-enquires, confirms, and OTP-gates).
 */
@Injectable()
export class SnapToPayService {
  private readonly logger = new Logger(SnapToPayService.name);

  constructor(
    @Inject(CHANNEL_ADAPTER) private readonly channel: ChannelAdapter,
    private readonly ai: AiService,
    private readonly bankTransfer: BankTransferService,
  ) {}

  async fromImage(user: UserRow, wallet: WalletRow, image: Buffer, mimeType: string): Promise<void> {
    if (wallet.currency !== 'NGN') {
      return this.send(user, 'Snap-to-pay is available for NGN wallets only.');
    }

    const snap = await this.extract(image, mimeType);
    const accountNumber = snap?.accountNumber && /^\d{10}$/.test(snap.accountNumber) ? snap.accountNumber : null;
    const { bankName, amount } = snap ?? { bankName: null, amount: null };

    if (!accountNumber) {
      return this.send(
        user,
        "📸 I couldn't read a bank account from that image. You can type it, e.g. *send 5000 to 0690000031 Access Bank*.",
      );
    }

    // Fully specified → hand straight to the OTP-gated bank transfer flow.
    if (bankName && amount) {
      return this.bankTransfer.start(user, wallet, amount, accountNumber, bankName);
    }

    // Partial → echo what we read so the user completes it in one line.
    const found = [`account *${accountNumber}*`];
    if (bankName) found.push(`at *${bankName}*`);
    if (amount) found.push(`amount *${formatMoney(wallet.currency as Currency, amount)}*`);
    return this.send(
      user,
      `📸 I read ${found.join(' ')}.\nTo send, reply:\n*send <amount> to ${accountNumber} ${bankName ?? '<bank>'}*`,
    );
  }

  /** One retry on invalid JSON, then give up (never guess) — per the extraction guardrail. */
  private async extract(image: Buffer, mimeType: string): Promise<Snap | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw: string;
      try {
        raw = await this.ai.extractFromImage(image, mimeType, SYSTEM, 'Extract the payee bank details.', {
          temperature: 0,
          maxTokens: 300,
        });
      } catch (err) {
        this.logger.error(`vision extract failed: ${(err as Error).message}`);
        return null;
      }
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          const parsed = SnapSchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
          if (parsed.success) return parsed.data;
        } catch {
          // fall through to retry
        }
      }
      this.logger.warn(`snap-to-pay got non-JSON (attempt ${attempt})`);
    }
    return null;
  }

  private async send(user: UserRow, body: string): Promise<void> {
    await this.channel.send({ to: user.wa_phone, kind: 'text', body });
  }
}
