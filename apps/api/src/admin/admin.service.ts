import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.constants';

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
