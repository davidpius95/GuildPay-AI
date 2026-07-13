import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { ChannelModule } from './channel/channel.module';
import { AiModule } from './ai/ai.module';
import { PartnerModule } from './partner/partner.module';
import { BillsModule } from './bills/bills.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Local dev runs from apps/api, but .env lives at the repo root. In Docker
      // the env comes from env_file (process.env), which ConfigModule reads too.
      envFilePath: ['.env', '../../.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Never log PINs, OTPs, tokens, or signatures (CLAUDE.md guardrail).
        redact: [
          'req.headers.authorization',
          'req.headers["x-hub-signature-256"]',
          'req.headers["verif-hash"]',
          'req.body.pin',
          'req.body.otp',
        ],
      },
    }),
    DatabaseModule,
    ChannelModule,
    AiModule,
    PartnerModule,
    BillsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
