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
  virtual_account_ref: string | null;
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

  async findById(id: string): Promise<WalletRow | null> {
    const { rows } = await this.pool.query<WalletRow>('select * from public.wallets where id = $1', [id]);
    return rows[0] ?? null;
  }

  async findByReference(reference: string): Promise<WalletRow | null> {
    const { rows } = await this.pool.query<WalletRow>(
      'select * from public.wallets where reference = $1',
      [reference],
    );
    return rows[0] ?? null;
  }

  /** Match a wallet by its provisioned NUBAN — used to credit inbound v4 funding. */
  async findByVirtualAccountNumber(accountNumber: string): Promise<WalletRow | null> {
    const { rows } = await this.pool.query<WalletRow>(
      'select * from public.wallets where virtual_account_number = $1',
      [accountNumber],
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

  /** Attach a provisioned virtual account (NUBAN) to a wallet after partner creation. */
  async setVirtualAccount(
    walletId: string,
    accountNumber: string,
    bankName: string,
    providerRef?: string,
  ): Promise<void> {
    await this.pool.query(
      `update public.wallets
         set virtual_account_number = $1, virtual_bank_name = $2, virtual_account_ref = $3
       where id = $4`,
      [accountNumber, bankName, providerRef ?? null, walletId],
    );
  }
}
