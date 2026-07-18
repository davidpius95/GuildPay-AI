import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCloudAdapter } from './meta-cloud.adapter';
import { TwilioSandboxAdapter } from './twilio-sandbox.adapter';
import { WhatsappFlowService } from './whatsapp-flow.service';

export const CHANNEL_ADAPTER = Symbol('CHANNEL_ADAPTER');

/**
 * Binds the active ChannelAdapter from env CHANNEL_ADAPTER (meta | twilio).
 * Inject with @Inject(CHANNEL_ADAPTER).
 */
@Module({
  providers: [
    MetaCloudAdapter,
    TwilioSandboxAdapter,
    WhatsappFlowService,
    {
      provide: CHANNEL_ADAPTER,
      inject: [ConfigService, MetaCloudAdapter, TwilioSandboxAdapter],
      useFactory: (config: ConfigService, meta: MetaCloudAdapter, twilio: TwilioSandboxAdapter) =>
        config.get<string>('CHANNEL_ADAPTER') === 'twilio' ? twilio : meta,
    },
  ],
  exports: [CHANNEL_ADAPTER, MetaCloudAdapter, TwilioSandboxAdapter, WhatsappFlowService],
})
export class ChannelModule {}
