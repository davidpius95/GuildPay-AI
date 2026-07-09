import { Module } from '@nestjs/common';
import { BillsService } from './bills.service';
import { FlutterwaveBillsAdapter } from './flutterwave-bills.adapter';

@Module({
  providers: [BillsService, FlutterwaveBillsAdapter],
  exports: [BillsService],
})
export class BillsModule {}
