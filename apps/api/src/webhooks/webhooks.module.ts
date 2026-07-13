import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { AiModule } from '../ai/ai.module';
import { WhatsappController } from './whatsapp.controller';
import { FlutterwaveController } from './flutterwave.controller';

@Module({
  imports: [ChannelModule, OnboardingModule, AiModule],
  controllers: [WhatsappController, FlutterwaveController],
})
export class WebhooksModule {}
