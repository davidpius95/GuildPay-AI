import { Injectable, Logger } from '@nestjs/common';
import type { InboundMessage } from '@guildpay/shared';
import type { ChannelAdapter, OutboundMessage } from './channel-adapter';

/**
 * TwilioSandboxAdapter — fallback WhatsApp transport (Week 0 item 5).
 * Stub: contract only. Twilio webhook form-parsing + REST send land in Week 1.
 */
@Injectable()
export class TwilioSandboxAdapter implements ChannelAdapter {
  readonly name = 'twilio' as const;
  private readonly logger = new Logger(TwilioSandboxAdapter.name);

  parseInbound(_payload: unknown): InboundMessage[] {
    this.logger.warn('TwilioSandboxAdapter.parseInbound stub — implemented in Week 1');
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.logger.log(`[twilio stub] would send ${message.kind} to ${message.to}`);
  }
}
