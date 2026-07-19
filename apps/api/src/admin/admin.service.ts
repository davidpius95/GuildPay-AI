import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.constants';

/** Validate a value is in an allowed set, else 400 — keeps bad input out of SQL. */
function oneOf<T extends string>(value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new BadRequestException(`value "${value}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export interface AdminUser {
  id: string;
  wa_phone: string;
  full_name: string | null;
  email: string | null;
  market: string | null;
  currency: string | null;
  status: string;
  kyc_status: string;
  onboarding_step: string;
  created_at: string;
  wallet_ref: string | null;
  balance: string | null;
  virtual_account_number: string | null;
}

/**
 * Admin operations — list users and destructively reset/delete them. Reset wipes a
 * user's money data back to a fresh onboarding; delete removes the user entirely.
 * All destructive work runs in a single transaction, in FK-dependency order.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Editable user fields an admin may change. All optional; only provided keys are written. */
  private static readonly EDITABLE = {
    full_name: (v: unknown) => (v == null ? null : String(v).slice(0, 120)),
    email: (v: unknown) => (v == null || v === '' ? null : String(v).slice(0, 200)),
    status: (v: unknown) => oneOf(String(v), ['pending', 'active', 'frozen', 'closed']),
    kyc_status: (v: unknown) => oneOf(String(v), ['pending', 'verified', 'failed']),
  } as const;

  /**
   * Update a user's profile/status/KYC fields. Non-money CRUD only — this never
   * touches wallets, balances, or the ledger. Validates each field against its
   * allowed set, writes the change to audit_events, and no-ops on an empty patch.
   */
  async updateUser(
    userId: string,
    patch: Partial<Record<keyof typeof AdminService.EDITABLE, unknown>>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const applied: Record<string, unknown> = {};

    for (const [key, coerce] of Object.entries(AdminService.EDITABLE)) {
      if (!(key in patch)) continue;
      const value = coerce(patch[key as keyof typeof AdminService.EDITABLE]);
      values.push(value);
      sets.push(`${key} = $${values.length}`);
      applied[key] = value;
    }
    if (sets.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      values.push(userId);
      await client.query(
        `update public.users set ${sets.join(', ')} where id = $${values.length}`,
        values,
      );
      await client.query(
        `insert into public.audit_events (user_id, actor, action, entity, entity_id, metadata)
         values ($1, 'admin', 'user_updated', 'user', $2, $3)`,
        [userId, userId, applied],
      );
      await client.query('commit');
      this.logger.log(`user ${userId} updated: ${Object.keys(applied).join(', ')}`);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Remove a saved beneficiary. Audited; verifies it belongs to the given user. */
  async deleteBeneficiary(userId: string, beneficiaryId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rowCount } = await client.query(
        'delete from public.beneficiaries where id = $1 and user_id = $2',
        [beneficiaryId, userId],
      );
      if (rowCount) {
        await client.query(
          `insert into public.audit_events (user_id, actor, action, entity, entity_id)
           values ($1, 'admin', 'beneficiary_deleted', 'beneficiary', $2)`,
          [userId, beneficiaryId],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listUsers(): Promise<AdminUser[]> {
    const { rows } = await this.pool.query<AdminUser>(
      `select u.id, u.wa_phone, u.full_name, u.email, u.market, u.currency, u.status,
              u.kyc_status, u.onboarding_step, u.created_at,
              w.reference as wallet_ref, w.balance::text as balance, w.virtual_account_number
       from public.users u
       left join public.wallets w on w.user_id = u.id
       order by u.created_at desc
       limit 200`,
    );
    return rows;
  }

  /** Delete all money data for a user (keeps the user row). */
  private async purgeUserData(client: PoolClient, userId: string): Promise<void> {
    const walletFilter = 'wallet_id in (select id from public.wallets where user_id = $1)';
    await client.query(`delete from public.ledger_entries where ${walletFilter}`, [userId]);
    await client.query('delete from public.otp_challenges where user_id = $1', [userId]);
    await client.query(`delete from public.transactions where ${walletFilter}`, [userId]);
    await client.query('delete from public.beneficiaries where user_id = $1', [userId]);
    await client.query('delete from public.wallets where user_id = $1', [userId]);
  }

  /** Reset a user to a fresh onboarding — wipes wallets/txns/ledger, clears profile. */
  async resetUser(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.purgeUserData(client, userId);
      await client.query(
        `update public.users set
           full_name = null, first_name = null, last_name = null, email = null,
           market = null, currency = null, kyc_id = null, kyc_status = 'pending',
           consent_at = null, status = 'pending', onboarding_step = 'language'
         where id = $1`,
        [userId],
      );
      await client.query(
        `insert into public.audit_events (user_id, actor, action, entity, entity_id)
         values ($1, 'admin', 'user_reset', 'user', $2)`,
        [userId, userId],
      );
      await client.query('commit');
      this.logger.log(`user ${userId} reset to fresh onboarding`);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Permanently delete a user and all their data. */
  async deleteUser(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.purgeUserData(client, userId);
      await client.query('delete from public.audit_events where user_id = $1', [userId]);
      await client.query('delete from public.users where id = $1', [userId]);
      await client.query('commit');
      this.logger.log(`user ${userId} deleted`);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Demo reset — wipe every user and all data. */
  async demoResetAll(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const t of [
        'ledger_entries',
        'otp_challenges',
        'transactions',
        'beneficiaries',
        'wallets',
        'audit_events',
        'users',
      ]) {
        await client.query(`delete from public.${t}`);
      }
      await client.query('commit');
      this.logger.warn('demo reset: all users and data wiped');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
