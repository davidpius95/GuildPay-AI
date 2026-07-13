import { Logger } from '@nestjs/common';
import type { SttProvider } from './stt-provider';

/**
 * Deepgram STT Provider using their REST API `/listen`.
 * Used as a fallback. Very fast and accurate for noisy WhatsApp voice notes.
 */
export class DeepgramSttProvider implements SttProvider {
  readonly name = 'deepgram';
  private readonly logger = new Logger(DeepgramSttProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'nova-2',
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.append('model', this.model);
    url.searchParams.append('smart_format', 'true');
    url.searchParams.append('punctuate', 'true');
    // WhatsApp voice notes can sometimes just be 'audio/ogg' without the codecs param.
    // We send whatever mimeType WhatsApp provided.

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': mimeType || 'audio/ogg',
      },
      body: audio, // Pass the buffer directly
    });

    if (!res.ok) {
      const errorText = await res.text();
      this.logger.error(`Deepgram STT failed (${res.status}): ${errorText}`);
      throw new Error(`Deepgram transcription failed: ${res.statusText}`);
    }

    const data = (await res.json()) as DeepgramResponse;
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return transcript.trim();
  }
}

interface DeepgramResponse {
  results?: {
    channels?: {
      alternatives?: {
        transcript?: string;
      }[];
    }[];
  };
}
