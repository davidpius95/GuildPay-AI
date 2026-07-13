import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';
import type { OpenAiCompatibleProvider } from './openai-compatible.provider';

/** Access the private provider chain without `any`. */
function providersOf(svc: AiService): OpenAiCompatibleProvider[] {
  return (svc as unknown as { providers: OpenAiCompatibleProvider[] }).providers;
}

describe('AiService (fallback orchestrator)', () => {
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService();
    vi.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'AI_PROVIDER_ORDER') return 'groq,gemini';
      if (key === 'GROQ_API_KEY') return 'test-groq-key';
      if (key === 'GEMINI_API_KEY') return 'test-gemini-key';
      return undefined;
    });
  });

  it('tries the first provider and succeeds', async () => {
    const aiService = new AiService(configService);
    const providers = providersOf(aiService);
    expect(providers.length).toBe(2);

    const groqChatSpy = vi.spyOn(providers[0]!, 'chat').mockResolvedValue('Groq response');
    const geminiChatSpy = vi.spyOn(providers[1]!, 'chat').mockResolvedValue('Gemini response');

    const reply = await aiService.chat('Hello');

    expect(reply).toBe('Groq response');
    expect(groqChatSpy).toHaveBeenCalledTimes(1);
    expect(geminiChatSpy).not.toHaveBeenCalled();
  });

  it('falls back to the second provider if the first fails', async () => {
    const aiService = new AiService(configService);
    const providers = providersOf(aiService);

    const groqChatSpy = vi.spyOn(providers[0]!, 'chat').mockRejectedValue(new Error('Rate limited'));
    const geminiChatSpy = vi.spyOn(providers[1]!, 'chat').mockResolvedValue('Gemini response');

    const reply = await aiService.chat('Hello');

    expect(reply).toBe('Gemini response');
    expect(groqChatSpy).toHaveBeenCalledTimes(1);
    expect(geminiChatSpy).toHaveBeenCalledTimes(1);
  });

  it('throws an aggregated error if all providers fail', async () => {
    const aiService = new AiService(configService);
    const providers = providersOf(aiService);

    vi.spyOn(providers[0]!, 'chat').mockRejectedValue(new Error('Groq down'));
    vi.spyOn(providers[1]!, 'chat').mockRejectedValue(new Error('Gemini down'));

    await expect(aiService.chat('Hello')).rejects.toThrow(
      'All AI providers failed: groq: Groq down | gemini: Gemini down',
    );
  });

  it('ignores providers without API keys', () => {
    vi.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'AI_PROVIDER_ORDER') return 'groq,gemini';
      if (key === 'GROQ_API_KEY') return 'test-groq-key';
      return undefined; // Gemini key missing
    });

    const aiService = new AiService(configService);
    expect(aiService.getActiveProviders()).toEqual(['groq']);
  });
});
