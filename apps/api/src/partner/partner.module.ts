import { Module } from '@nestjs/common';
import { PartnerService } from './partner.service';
import { MockPartnerAdapter } from './mock-partner.adapter';
import { FlutterwavePartnerAdapter } from './flutterwave-partner.adapter';

@Module({
  providers: [PartnerService, MockPartnerAdapter, FlutterwavePartnerAdapter],
  exports: [PartnerService],
})
export class PartnerModule {}
