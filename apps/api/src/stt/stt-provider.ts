export interface SttProvider {
  /** The unique name of the provider (e.g. 'groq', 'deepgram') */
  readonly name: string;

  /**
   * Transcribe a binary audio buffer into text.
   * @param audio The raw audio buffer.
   * @param mimeType The mime type (e.g. 'audio/ogg; codecs=opus')
   * @returns The transcribed text string.
   */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}
