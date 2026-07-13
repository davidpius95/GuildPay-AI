import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [ChannelModule], // DatabaseModule is @Global; repositories are available
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
