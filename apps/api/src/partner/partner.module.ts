import { Module } from '@nestjs/common';
import { PartnerService } from './partner.service';
import { MockPartnerAdapter } from './mock-partner.adapter';
import { FlutterwavePartnerAdapter } from './flutterwave-partner.adapter';
import { FlutterwaveV4TokenService } from './flutterwave-v4-token.service';
import { FlutterwaveV4Client } from './flutterwave-v4.client';

@Module({
  providers: [
    PartnerService,
    MockPartnerAdapter,
    FlutterwavePartnerAdapter,
    FlutterwaveV4TokenService,
    FlutterwaveV4Client,
  ],
  exports: [PartnerService, FlutterwavePartnerAdapter],
})
export class PartnerModule {}
