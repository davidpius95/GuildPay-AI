import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody: true keeps the raw request buffer so we can verify webhook
  // signatures (Meta X-Hub-Signature-256) over the exact bytes received.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  app.get(Logger).log(`GuildPay API listening on :${port}`);
}

void bootstrap();
