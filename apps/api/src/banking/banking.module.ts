import { Module } from '@nestjs/common';
import { ChannelModule } from '../channel/channel.module';
import { AiModule } from '../ai/ai.module';
import { WalletService } from './wallet.service';
import { OtpService } from './otp.service';
import { OrchestratorService } from './orchestrator.service';
import { TransferService } from './transfer.service';
import { MessageRouter } from './message-router.service';

/**
 * Banking = the money brain for onboarded users: ledger (WalletService), OTP gate,
 * intent orchestrator, transfer flow, and the MessageRouter that ties them together.
 * DatabaseModule is @Global; repositories are injected directly.
 */
@Module({
  imports: [ChannelModule, AiModule],
  providers: [WalletService, OtpService, OrchestratorService, TransferService, MessageRouter],
  exports: [MessageRouter, WalletService, OtpService],
})
export class BankingModule {}
