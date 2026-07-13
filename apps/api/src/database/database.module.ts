import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from './database.constants';
import { UsersRepository } from './users.repository';
import { WalletsRepository } from './wallets.repository';
import { TransactionsRepository } from './transactions.repository';
import { AuditRepository } from './audit.repository';

/**
 * Postgres access to Supabase over DATABASE_URL (session pooler). Raw SQL via a
 * connection pool — avoids the Data API / PostgREST table-exposure caveat, and
 * the connection role bypasses RLS for backend work.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({
          connectionString: config.get<string>('DATABASE_URL'),
          ssl: { rejectUnauthorized: false }, // Supabase requires TLS
          max: 10,
        }),
    },
    UsersRepository,
    WalletsRepository,
    TransactionsRepository,
    AuditRepository,
  ],
  exports: [PG_POOL, UsersRepository, WalletsRepository, TransactionsRepository, AuditRepository],
})
export class DatabaseModule {}
