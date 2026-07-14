import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './database.constants';

export interface UserRow {
  id: string;
  wa_phone: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  language: string;
  market: string | null;
  currency: string | null;
  kyc_id: string | null;
  kyc_status: string;
  kyc_expiry: string | null;
  consent_at: string | null;
  pin_hash: string | null;
  status: string;
  onboarding_step: string;
  created_at: string;
  updated_at: string;
}

/** Fields onboarding/admin are allowed to update on a user. */
export type UserUpdate = Partial<
  Pick<
    UserRow,
    | 'full_name'
    | 'first_name'
    | 'last_name'
    | 'email'
    | 'language'
    | 'market'
    | 'currency'
    | 'kyc_id'
    | 'kyc_status'
    | 'status'
    | 'onboarding_step'
  >
> & { consent_at?: 'now' };

@Injectable()
export class UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByWaPhone(waPhone: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>('select * from public.users where wa_phone = $1', [
      waPhone,
    ]);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>('select * from public.users where id = $1', [id]);
    return rows[0] ?? null;
  }

  async findByAnyWaPhone(waPhones: string[]): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>(
      'select * from public.users where wa_phone = any($1) limit 1',
      [waPhones],
    );
    return rows[0] ?? null;
  }

  /** Create a pending user at the first onboarding step (language). */
  async create(waPhone: string): Promise<UserRow> {
    const { rows } = await this.pool.query<UserRow>(
      `insert into public.users (wa_phone, status, onboarding_step)
       values ($1, 'pending', 'language')
       returning *`,
      [waPhone],
    );
    return rows[0]!;
  }

  async update(id: string, patch: UserUpdate): Promise<UserRow> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'consent_at') {
        sets.push(`consent_at = now()`);
        continue;
      }
      sets.push(`${key} = $${i++}`);
      values.push(value);
    }
    values.push(id);
    const { rows } = await this.pool.query<UserRow>(
      `update public.users set ${sets.join(', ')} where id = $${i} returning *`,
      values,
    );
    return rows[0]!;
  }
}
