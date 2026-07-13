import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { InboundMessage } from '@guildpay/shared';
import { MetaCloudAdapter } from '../channel/meta-cloud.adapter';
import { OnboardingService } from '../onboarding/onboarding.service';
import { MessageRouter } from '../banking/message-router.service';
import { SttService } from '../stt/stt.service';

/**
 * WhatsApp webhook (Meta Cloud API).
 *   GET  /webhooks/whatsapp  — subscription verification challenge.
 *   POST /webhooks/whatsapp  — inbound messages (signature-verified) → onboarding
 *                              state machine; onboarded users fall through to echo.
 * Always returns 200 quickly so Meta does not retry; failures are logged.
 */
@Controller('webhooks/whatsapp')
export class WhatsappController {
  private readonly logger = new Logger(WhatsappController.name);

  constructor(
    private readonly meta: MetaCloudAdapter,
    private readonly onboarding: OnboardingService,
    private readonly router: MessageRouter,
    private readonly stt: SttService,
  ) {}

  @Get()
  verify(@Query() query: Record<string, string>): string {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && this.meta.verifyToken(token)) {
      this.logger.log('WhatsApp webhook verified');
      return challenge ?? '';
    }
    throw new ForbiddenException('verification failed');
  }

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Body() body: unknown): { status: string } {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!this.meta.verifySignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }

    // Acknowledge Meta immediately (avoids webhook retries / duplicate replies while
    // a slow LLM call runs), then process in the background.
    const messages = this.meta.parseInbound(body);
    void this.process(messages);
    return { status: 'ok' };
  }

  private async process(messages: InboundMessage[]): Promise<void> {
    for (const msg of messages) {
      // Show the "typing…" indicator (also marks the message read) while we work.
      if (msg.messageId) {
        await this.meta.showTyping(msg.messageId).catch((err) =>
          this.logger.warn(`typing indicator failed: ${(err as Error).message}`),
        );
      }
      try {
        const handled = await this.onboarding.handle(msg);
        if (!handled) {
          // Onboarded user — if it's an audio note, transcribe it first
          if (msg.type === 'audio' && msg.mediaId) {
            try {
              const { buffer, mimeType } = await this.meta.downloadMedia(msg.mediaId);
              const transcript = await this.stt.transcribe(buffer, mimeType);
              this.logger.log(`Transcribed voice note to: "${transcript}"`);
              
              // Mutate the message into a text message for the router
              msg.type = 'text';
              msg.text = transcript;
            } catch (sttErr) {
              this.logger.error(`STT transcription failed: ${(sttErr as Error).message}`);
              await this.meta.send({
                to: msg.waPhone,
                kind: 'text',
                body: 'Sorry, I had trouble hearing that voice note. Could you type it instead? 🎤',
              });
              return; // Halt processing for this message
            }
          }

          // Hand off to the banking router (intent → capability).
          await this.router.handle(msg);
        }
      } catch (err) {
        this.logger.error(`message handling failed: ${(err as Error).message}`);
      }
    }
  }
}
