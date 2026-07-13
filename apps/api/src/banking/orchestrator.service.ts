import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiService } from '../ai/ai.service';

/** Intents the orchestrator can route (subset of the full catalogue). */
export const IntentResultSchema = z.object({
  intent: z.enum(['balance', 'fund', 'p2p_transfer', 'bank_transfer', 'support', 'unknown']),
  amount: z.number().positive().nullable().default(null),
  recipientRef: z.string().min(1).nullable().default(null), // phone number or GuildPay ref (p2p)
  accountNumber: z.string().min(1).nullable().default(null), // 10-digit NUBAN (bank_transfer)
  bankName: z.string().min(1).nullable().default(null), // bank name text (bank_transfer)
  purpose: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type IntentResult = z.infer<typeof IntentResultSchema>;

const SYSTEM = `You are the intent parser for GuildPay, a WhatsApp money assistant.
Read the user's message and output ONLY a JSON object (no prose, no markdown) with keys:
- "intent": one of "balance", "fund", "p2p_transfer", "bank_transfer", "support", "unknown".
- "amount": the money amount as a number, or null if not clearly stated.
- "recipientRef": the recipient's phone number or GuildPay reference for a P2P transfer, else null.
- "accountNumber": the destination bank account number (10 digits) for a bank transfer, else null.
- "bankName": the destination bank's name for a bank transfer, else null.
- "purpose": short reason for the payment, or null.
- "confidence": 0 to 1.
Rules: NEVER invent an amount, recipient, account number, or bank — use null when unsure.
"balance" = checking balance. "fund" = adding money to their own wallet.
"p2p_transfer" = sending to another GuildPay user (phone/GuildPay ref).
"bank_transfer" = sending to a bank account number at a named bank (NIP).
Greetings, questions, or anything else = "support".`;

/**
 * Turns free-text into a validated intent. The LLM only interprets; it never
 * moves money. Invalid JSON → one retry → "unknown" (the router then clarifies).
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(private readonly ai: AiService) {}

  async parse(text: string): Promise<IntentResult> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw: string;
      try {
        raw = await this.ai.complete(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: text },
          ],
          { temperature: 0, maxTokens: 300 },
        );
      } catch (err) {
        this.logger.error(`orchestrator LLM call failed: ${(err as Error).message}`);
        break;
      }
      const parsed = this.tryParse(raw);
      if (parsed) return parsed;
      this.logger.warn(`orchestrator got non-JSON (attempt ${attempt})`);
    }
    return IntentResultSchema.parse({ intent: 'unknown', confidence: 0 });
  }

  private tryParse(raw: string): IntentResult | null {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return IntentResultSchema.parse(JSON.parse(raw.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}
