import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency, TransactionType } from '@guildpay/shared';
import { PG_POOL } from './database.constants';

export interface TransactionRow {
  id: string;
  wallet_id: string;
  type: string;
  channel: string;
  status: string;
  amount: string; // NUMERIC → string from pg
  fee: string;
  currency: string;
  recipient_name: string | null;
  recipient_ref: string | null;
  bank_code: string | null;
  purpose: string | null;
  ai_extraction: unknown;
  provider_ref: string | null;
  confirmed_at: string | null;
  created_at: string;
}

@Injectable()
export class TransactionsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(params: {
    walletId: string;
    type: TransactionType;
    channel: string;
    currency: Currency;
    amount: number;
    recipientName?: string | null;
    recipientRef?: string | null;
    purpose?: string | null;
    aiExtraction?: unknown;
    providerRef?: string | null;
    status?: string;
  }): Promise<TransactionRow> {
    const { rows } = await this.pool.query<TransactionRow>(
      `insert into public.transactions
         (wallet_id, type, channel, currency, amount, recipient_name, recipient_ref, purpose, ai_extraction, provider_ref, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,'draft'))
       returning *`,
      [
        params.walletId,
        params.type,
        params.channel,
        params.currency,
        params.amount,
        params.recipientName ?? null,
        params.recipientRef ?? null,
        params.purpose ?? null,
        params.aiExtraction ? JSON.stringify(params.aiExtraction) : null,
        params.providerRef ?? null,
        params.status ?? null,
      ],
    );
    return rows[0]!;
  }

  /** Idempotency: has a transaction already recorded this provider (Flutterwave) reference? */
  async findByProviderRef(providerRef: string): Promise<TransactionRow | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      'select * from public.transactions where provider_ref = $1 limit 1',
      [providerRef],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<TransactionRow | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      'select * from public.transactions where id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /** The most recent transaction for a wallet in any of the given statuses. */
  async findLatestByStatus(walletId: string, statuses: string[]): Promise<TransactionRow | null> {
    const { rows } = await this.pool.query<TransactionRow>(
      `select * from public.transactions
       where wallet_id = $1 and status = any($2)
       order by created_at desc limit 1`,
      [walletId, statuses],
    );
    return rows[0] ?? null;
  }

  async setStatus(id: string, status: string): Promise<void> {
    const confirmed = status === 'completed' ? ', confirmed_at = now()' : '';
    await this.pool.query(`update public.transactions set status = $1${confirmed} where id = $2`, [
      status,
      id,
    ]);
  }
}
