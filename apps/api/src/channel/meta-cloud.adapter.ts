import { Injectable, Logger } from '@nestjs/common';
import type { InboundMessage } from '@guildpay/shared';
import type { ChannelAdapter, OutboundMessage } from './channel-adapter';

/**
 * MetaCloudAdapter — primary WhatsApp transport (Meta Cloud API).
 * Stub: contract only. Signature verification (X-Hub-Signature-256), webhook
 * normalization, media download, and interactive/text send land in Week 1.
 */
@Injectable()
export class MetaCloudAdapter implements ChannelAdapter {
  readonly name = 'meta' as const;
  private readonly logger = new Logger(MetaCloudAdapter.name);

  parseInbound(_payload: unknown): InboundMessage[] {
    this.logger.warn('MetaCloudAdapter.parseInbound stub — implemented in Week 1');
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.logger.log(`[meta stub] would send ${message.kind} to ${message.to}`);
  }
}
