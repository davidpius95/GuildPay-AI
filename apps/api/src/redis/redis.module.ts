import { Global, Module, Logger, type OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { InMemoryRedis, type RedisLike } from './in-memory-redis';
import { RedisService } from './redis.service';

/**
 * Global Redis access. When REDIS_URL is set we connect a real ioredis client;
 * otherwise we fall back to an in-process store so tests and local dev run with
 * zero infra. Either way the rest of the app depends only on RedisService.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RedisLike => {
        const logger = new Logger('RedisModule');
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          logger.warn('REDIS_URL not set — using in-memory context store (not shared across instances).');
          return new InMemoryRedis();
        }
        const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
        client.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
        logger.log('Redis client connected via REDIS_URL.');
        return client as unknown as RedisLike;
      },
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisLike) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit?.().catch(() => undefined);
  }
}
