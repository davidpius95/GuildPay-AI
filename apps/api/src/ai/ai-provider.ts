/**
 * AI provider interface & shared types.
 * Every LLM backend (Groq, Gemini, OpenRouter, …) implements AiProvider.
 * The AiService orchestrator calls them in fallback order.
 */

/** A multimodal content part (OpenAI-compatible: text or an image data/URL). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** A single message in the chat history (OpenAI-compatible shape). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/** Options forwarded to the provider's chat endpoint. */
export interface ChatOptions {
  /** Max tokens to generate. Defaults vary per provider. */
  maxTokens?: number;
  /** Sampling temperature (0–2). */
  temperature?: number;
  /** Abort after this many milliseconds. Default: 30 000. */
  timeoutMs?: number;
}

/**
 * AiProvider — a single LLM backend that can complete a chat.
 * Implementations must throw on any non-success response so the
 * AiService fallback logic can catch and retry the next provider.
 */
export interface AiProvider {
  /** Human-readable name used in logs and env (e.g. 'groq', 'gemini'). */
  readonly name: string;
  /** Send a chat completion request. Returns the assistant's reply text. */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}
