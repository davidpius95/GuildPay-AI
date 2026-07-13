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
import { MetaCloudAdapter } from '../channel/meta-cloud.adapter';
import { OnboardingService } from '../onboarding/onboarding.service';

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
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<{ status: string }> {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!this.meta.verifySignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }

    const messages = this.meta.parseInbound(body);
    for (const msg of messages) {
      try {
        const handled = await this.onboarding.handle(msg);
        if (!handled) {
          // Onboarded user — placeholder until the AI orchestrator (M3) lands.
          const reply =
            msg.type === 'text' && msg.text
              ? `You said: "${msg.text}"`
              : `Got your ${msg.type} message — GuildPay is still learning to handle that. 🙂`;
          await this.meta.send({ to: msg.waPhone, kind: 'text', body: reply });
        }
      } catch (err) {
        this.logger.error(`message handling failed: ${(err as Error).message}`);
      }
    }
    return { status: 'ok' };
  }
}
