import { Logger } from '@nestjs/common';
import type { AiProvider, ChatMessage, ChatOptions } from './ai-provider';

/**
 * OpenAiCompatibleProvider — a generic provider that works with any API
 * implementing the OpenAI chat-completions contract:
 *   POST {baseUrl}/chat/completions
 *
 * Groq, Google Gemini (OpenAI layer), OpenRouter, Together, Mistral, and many
 * others expose this exact interface, so one class covers them all.
 *
 * Uses Node 20's built-in `fetch` — no SDKs required.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  private readonly logger: Logger;

  constructor(
    private readonly providerName: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.logger = new Logger(`AiProvider:${this.providerName}`);
  }

  get name(): string {
    return this.providerName;
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    const body = {
      model: this.model,
      messages,
      ...(opts?.maxTokens != null && { max_tokens: opts.maxTokens }),
      ...(opts?.temperature != null && { temperature: opts.temperature }),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '(unreadable body)');
        throw new Error(
          `[${this.providerName}] ${res.status} ${res.statusText}: ${detail}`,
        );
      }

      const json = (await res.json()) as OpenAiChatResponse;
      const content = json.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(`[${this.providerName}] empty response — no content in choices[0]`);
      }

      this.logger.debug(`${this.providerName} replied (${content.length} chars, model=${json.model})`);
      return content;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`[${this.providerName}] request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Minimal shape of the OpenAI chat completions response we read. */
interface OpenAiChatResponse {
  model?: string;
  choices?: {
    message?: {
      role?: string;
      content?: string;
    };
  }[];
}
