import { Module } from '@nestjs/common';
import { PartnerModule } from '../partner/partner.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { OpsService } from './ops.service';

@Module({
  imports: [PartnerModule],
  controllers: [AdminController],
  providers: [AdminService, OpsService],
})
export class AdminModule {}
