import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Currency } from '@guildpay/shared';
import { PG_POOL } from './database.constants';

export interface BeneficiaryRow {
  id: string;
  user_id: string;
  name: string;
  ref: string;
  bank_code: string | null;
  currency: string;
  created_at: string;
}

@Injectable()
export class BeneficiariesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Save a beneficiary (idempotent on user_id + ref + bank_code). */
  async add(params: {
    userId: string;
    name: string;
    ref: string;
    bankCode?: string | null;
    currency: Currency;
  }): Promise<void> {
    await this.pool.query(
      `insert into public.beneficiaries (user_id, name, ref, bank_code, currency)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, ref, bank_code) do nothing`,
      [params.userId, params.name, params.ref, params.bankCode ?? null, params.currency],
    );
  }

  async listByUser(userId: string): Promise<BeneficiaryRow[]> {
    const { rows } = await this.pool.query<BeneficiaryRow>(
      'select * from public.beneficiaries where user_id = $1 order by created_at desc',
      [userId],
    );
    return rows;
  }
}
