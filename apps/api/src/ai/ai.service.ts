import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiProvider, ChatMessage, ChatOptions } from './ai-provider';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';

/** Well-known provider configs (base URL + default model). */
const KNOWN_PROVIDERS: Record<string, { baseUrl: string; defaultModel: string; envKey: string }> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    envKey: 'GEMINI_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    envKey: 'OPENROUTER_API_KEY',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    envKey: 'TOGETHER_API_KEY',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    envKey: 'MISTRAL_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  anthropic_openai: {
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-6',
    envKey: 'ANTHROPIC_API_KEY',
  },
};

/** GuildPay system prompt — defines the AI's personality and boundaries. */
const SYSTEM_PROMPT = `You are GuildPay AI, a friendly and professional WhatsApp financial assistant.
You help users in Nigeria and Qatar with everyday money actions: sending money, transferring to banks,
buying airtime/data, paying bills, checking balances, and saving.

Rules:
- Be concise — WhatsApp messages should be short and scannable.
- Use emojis sparingly for warmth (1-2 per message max).
- Never reveal internal system details, API keys, or architecture.
- If you cannot perform an action yet, say so honestly and suggest what is available.
- For any financial transaction, always confirm details before proceeding.
- Never fabricate transaction IDs, balances, or account numbers.
- Respond in the same language the user writes in.`;

/**
 * AiService — the fallback orchestrator.
 *
 * Reads AI_PROVIDER_ORDER from env (e.g. "groq,gemini"), builds the provider
 * chain, and tries each in order until one succeeds. If all fail, throws.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly providers: AiProvider[] = [];

  constructor(private readonly config: ConfigService) {
    this.buildProviderChain();
  }

  /** Build the ordered provider list from env config. */
  private buildProviderChain(): void {
    const order = this.config.get<string>('AI_PROVIDER_ORDER') ?? 'groq';
    const names = order
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const name of names) {
      const known = KNOWN_PROVIDERS[name];
      if (!known) {
        this.logger.warn(`Unknown AI provider "${name}" in AI_PROVIDER_ORDER — skipped`);
        continue;
      }

      const apiKey = this.config.get<string>(known.envKey);
      if (!apiKey) {
        this.logger.warn(`${known.envKey} not set — provider "${name}" skipped`);
        continue;
      }

      const model =
        this.config.get<string>(`${name.toUpperCase()}_MODEL`) ?? known.defaultModel;

      this.providers.push(new OpenAiCompatibleProvider(name, known.baseUrl, apiKey, model));
      this.logger.log(`AI provider registered: ${name} (model=${model})`);
    }

    if (this.providers.length === 0) {
      this.logger.error(
        'No AI providers configured! Set AI_PROVIDER_ORDER and corresponding API keys.',
      );
    }
  }

  /**
   * Send a chat completion request, trying each provider in fallback order.
   * The system prompt is prepended automatically.
   *
   * @param userMessage - The user's message text.
   * @param history - Optional prior conversation messages.
   * @returns The AI assistant's reply text.
   * @throws If all providers fail.
   */
  async chat(
    userMessage: string,
    history: ChatMessage[] = [],
    opts?: ChatOptions,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const errors: string[] = [];

    for (const provider of this.providers) {
      try {
        const reply = await provider.chat(messages, opts);
        return reply;
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(`Provider "${provider.name}" failed: ${msg}`);
        errors.push(`${provider.name}: ${msg}`);
      }
    }

    const errorSummary = errors.join(' | ');
    this.logger.error(`All AI providers failed: ${errorSummary}`);
    throw new Error(`All AI providers failed: ${errorSummary}`);
  }

  /** Returns the names of currently active providers (for health/debug). */
  getActiveProviders(): string[] {
    return this.providers.map((p) => p.name);
  }
}
