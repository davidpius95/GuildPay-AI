import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, ForbiddenException, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Flutterwave webhook. Verifies the `verif-hash` header against the secret hash
 * configured in the Flutterwave dashboard (FLW_WEBHOOK_SECRET_HASH). Handling of
 * funding / payout / bill events lands with the NGN rail (Week 2.5); for now it
 * verifies + acknowledges so the endpoint is real and testable.
 */
@Controller('webhooks/flutterwave')
export class FlutterwaveController {
  private readonly logger = new Logger(FlutterwaveController.name);

  constructor(private readonly config: ConfigService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Headers('verif-hash') hash: string | undefined,
    @Body() body: { event?: string; 'event.type'?: string },
  ): { status: string } {
    const expected = this.config.get<string>('FLW_WEBHOOK_SECRET_HASH');
    if (!expected || !hash || !constantTimeEqual(hash, expected)) {
      throw new ForbiddenException('invalid verif-hash');
    }
    this.logger.log(`Flutterwave event: ${body?.event ?? body?.['event.type'] ?? 'unknown'}`);
    return { status: 'ok' };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
