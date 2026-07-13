import { Logger } from '@nestjs/common';
import type { SttProvider } from './stt-provider';

/**
 * Groq STT Provider using their OpenAI-compatible `/audio/transcriptions` endpoint.
 * Very fast, uses Whisper Large V3.
 */
export class GroqSttProvider implements SttProvider {
  readonly name = 'groq';
  private readonly logger = new Logger(GroqSttProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'whisper-large-v3',
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const url = 'https://api.groq.com/openai/v1/audio/transcriptions';

    // WhatsApp OGG format usually maps well to standard extensions.
    const ext = mimeType.includes('ogg') ? 'ogg' : 'm4a';
    
    // Node.js 20 native FormData
    const formData = new FormData();
    // Convert Buffer to Blob for native FormData
    const blob = new Blob([audio], { type: mimeType });
    formData.append('file', blob, `voice_note.${ext}`);
    formData.append('model', this.model);
    formData.append('response_format', 'json');

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        // Note: Do NOT set Content-Type header manually when using FormData in fetch.
        // The browser/Node will automatically set it to multipart/form-data with the correct boundary.
      },
      body: formData,
    });

    if (!res.ok) {
      const errorText = await res.text();
      this.logger.error(`Groq STT failed (${res.status}): ${errorText}`);
      throw new Error(`Groq transcription failed: ${res.statusText}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text;
  }
}
