import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { AiModule } from '../ai/ai.module';
import { PartnerModule } from '../partner/partner.module';
import { WalletService } from './wallet.service';
import { OtpService } from './otp.service';
import { OrchestratorService } from './orchestrator.service';
import { TransferService } from './transfer.service';
import { BankTransferService } from './bank-transfer.service';
import { SnapToPayService } from './snap-to-pay.service';
import { ReceiptService } from './receipt.service';
import { MessageRouter } from './message-router.service';

/**
 * Banking = the money brain for onboarded users: ledger (WalletService), OTP gate,
 * intent orchestrator, transfer flows (P2P + NIP), and the MessageRouter that ties
 * them together. DatabaseModule is @Global; repositories are injected directly.
 */
@Module({
  imports: [ChannelModule, AiModule, PartnerModule],
  providers: [
    WalletService,
    OtpService,
    OrchestratorService,
    TransferService,
    BankTransferService,
    SnapToPayService,
    ReceiptService,
    MessageRouter,
  ],
  exports: [MessageRouter, WalletService, OtpService],
})
export class BankingModule {}
