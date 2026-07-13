import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SttProvider } from './stt-provider';
import { GroqSttProvider } from './groq-stt.provider';
import { DeepgramSttProvider } from './deepgram-stt.provider';

@Injectable()
export class SttService {
  private readonly logger = new Logger(SttService.name);
  private readonly providers: SttProvider[] = [];

  constructor(private readonly config: ConfigService) {
    this.buildProviderChain();
  }

  private buildProviderChain(): void {
    const order = this.config.get<string>('STT_PROVIDER_ORDER') ?? 'groq';
    const names = order
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    for (const name of names) {
      if (name === 'groq') {
        const apiKey = this.config.get<string>('GROQ_API_KEY');
        if (apiKey) {
          this.providers.push(new GroqSttProvider(apiKey));
          this.logger.log('STT provider registered: groq');
        } else {
          this.logger.warn('GROQ_API_KEY not set — STT provider "groq" skipped');
        }
      } else if (name === 'deepgram') {
        const apiKey = this.config.get<string>('DEEPGRAM_API_KEY');
        if (apiKey) {
          this.providers.push(new DeepgramSttProvider(apiKey));
          this.logger.log('STT provider registered: deepgram');
        } else {
          this.logger.warn('DEEPGRAM_API_KEY not set — STT provider "deepgram" skipped');
        }
      } else {
        this.logger.warn(`Unknown STT provider "${name}" in STT_PROVIDER_ORDER — skipped`);
      }
    }

    if (this.providers.length === 0) {
      this.logger.error('No STT providers configured! Set STT_PROVIDER_ORDER and API keys.');
    }
  }

  /**
   * Transcribe an audio buffer, trying each configured provider in order.
   * @param audio Binary audio buffer
   * @param mimeType Audio mime type
   * @returns Transcribed text
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (this.providers.length === 0) {
      throw new Error('No STT providers are configured to handle voice notes.');
    }

    const errors: string[] = [];

    for (const provider of this.providers) {
      try {
        const text = await provider.transcribe(audio, mimeType);
        return text;
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(`Provider "${provider.name}" failed: ${msg}`);
        errors.push(`${provider.name}: ${msg}`);
      }
    }

    const errorSummary = errors.join(' | ');
    this.logger.error(`All STT providers failed: ${errorSummary}`);
    throw new Error(`All STT providers failed: ${errorSummary}`);
  }

  getActiveProviders(): string[] {
    return this.providers.map((p) => p.name);
  }
}
