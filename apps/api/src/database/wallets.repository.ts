import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency, Market } from '@guildpay/shared';
import { PG_POOL } from './database.constants';

export interface WalletRow {
  id: string;
  user_id: string;
  reference: string;
  currency: string;
  market: string;
  balance: string; // numeric comes back as string from pg
  status: string;
  virtual_account_number: string | null;
  virtual_bank_name: string | null;
  daily_limit: string;
  txn_limit: string;
  created_at: string;
}

@Injectable()
export class WalletsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByUserId(userId: string): Promise<WalletRow[]> {
    const { rows } = await this.pool.query<WalletRow>(
      'select * from public.wallets where user_id = $1',
      [userId],
    );
    return rows;
  }

  async findByReference(reference: string): Promise<WalletRow | null> {
    const { rows } = await this.pool.query<WalletRow>(
      'select * from public.wallets where reference = $1',
      [reference],
    );
    return rows[0] ?? null;
  }

  async create(params: {
    userId: string;
    reference: string;
    currency: Currency;
    market: Market;
  }): Promise<WalletRow> {
    const { rows } = await this.pool.query<WalletRow>(
      `insert into public.wallets (user_id, reference, currency, market)
       values ($1, $2, $3, $4)
       returning *`,
      [params.userId, params.reference, params.currency, params.market],
    );
    return rows[0]!;
  }
}
