import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { PartnerModule } from '../partner/partner.module';
import { PinService } from '../banking/pin.service';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [ChannelModule, PartnerModule], // DatabaseModule is @Global; repositories are available
  providers: [OnboardingService, PinService], // PinService is stateless — provided locally, no module cycle
  exports: [OnboardingService],
})
export class OnboardingModule {}
