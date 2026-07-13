import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { SttService } from './stt.service';

describe('SttService', () => {
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService();
    vi.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'STT_PROVIDER_ORDER') return 'groq,deepgram';
      if (key === 'GROQ_API_KEY') return 'test-groq';
      if (key === 'DEEPGRAM_API_KEY') return 'test-deepgram';
      return undefined;
    });
  });

  it('tries the first provider and succeeds', async () => {
    const service = new SttService(configService);
    const providers = (service as any).providers;
    
    const groqSpy = vi.spyOn(providers[0], 'transcribe').mockResolvedValue('Hello Groq');
    const deepgramSpy = vi.spyOn(providers[1], 'transcribe').mockResolvedValue('Hello Deepgram');

    const result = await service.transcribe(Buffer.from(''), 'audio/ogg');
    
    expect(result).toBe('Hello Groq');
    expect(groqSpy).toHaveBeenCalledTimes(1);
    expect(deepgramSpy).not.toHaveBeenCalled();
  });

  it('falls back to second provider if first fails', async () => {
    const service = new SttService(configService);
    const providers = (service as any).providers;
    
    const groqSpy = vi.spyOn(providers[0], 'transcribe').mockRejectedValue(new Error('Groq dead'));
    const deepgramSpy = vi.spyOn(providers[1], 'transcribe').mockResolvedValue('Hello Deepgram');

    const result = await service.transcribe(Buffer.from(''), 'audio/ogg');
    
    expect(result).toBe('Hello Deepgram');
    expect(groqSpy).toHaveBeenCalledTimes(1);
    expect(deepgramSpy).toHaveBeenCalledTimes(1);
  });

  it('throws if all fail', async () => {
    const service = new SttService(configService);
    const providers = (service as any).providers;
    
    vi.spyOn(providers[0], 'transcribe').mockRejectedValue(new Error('Groq dead'));
    vi.spyOn(providers[1], 'transcribe').mockRejectedValue(new Error('Deepgram dead'));

    await expect(service.transcribe(Buffer.from(''), 'audio/ogg')).rejects.toThrow(
      'All STT providers failed: groq: Groq dead | deepgram: Deepgram dead'
    );
  });
});
