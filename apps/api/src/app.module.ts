import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health/health.controller';
import { ChannelModule } from './channel/channel.module';
import { PartnerModule } from './partner/partner.module';
import { BillsModule } from './bills/bills.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Never log PINs, OTPs, or full QID numbers (CLAUDE.md guardrail).
        redact: ['req.headers.authorization', 'req.body.pin', 'req.body.otp'],
      },
    }),
    ChannelModule,
    PartnerModule,
    BillsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
