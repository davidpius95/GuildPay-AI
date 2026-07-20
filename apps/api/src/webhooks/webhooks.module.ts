import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { BankingModule } from '../banking/banking.module';
import { PartnerModule } from '../partner/partner.module';
import { SttModule } from '../stt/stt.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappFlowController } from './whatsapp-flow.controller';
import { FlutterwaveController } from './flutterwave.controller';
import { FlutterwaveV4Controller } from './flutterwave-v4.controller';

@Module({
  imports: [ChannelModule, OnboardingModule, BankingModule, PartnerModule, SttModule],
  controllers: [WhatsappController, WhatsappFlowController, FlutterwaveController, FlutterwaveV4Controller],
})
export class WebhooksModule {}
