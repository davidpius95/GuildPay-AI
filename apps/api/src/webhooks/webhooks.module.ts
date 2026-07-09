import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { WhatsappController } from './whatsapp.controller';
import { FlutterwaveController } from './flutterwave.controller';

@Module({
  imports: [ChannelModule],
  controllers: [WhatsappController, FlutterwaveController],
})
export class WebhooksModule {}
