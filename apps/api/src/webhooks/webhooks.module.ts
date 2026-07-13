import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { WhatsappController } from './whatsapp.controller';
import { FlutterwaveController } from './flutterwave.controller';

@Module({
  imports: [ChannelModule, OnboardingModule],
  controllers: [WhatsappController, FlutterwaveController],
})
export class WebhooksModule {}
