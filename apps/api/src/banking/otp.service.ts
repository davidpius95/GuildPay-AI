import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.constants';

interface OtpRow {
  id: string;
  transaction_id: string | null;
  code_hash: string;
  attempts: number;
  max_attempts: number;
}

export interface OtpVerifyResult {
  ok: boolean;
  transactionId?: string | null;
  reason?: 'no_active_code' | 'too_many_attempts' | 'wrong_code';
}

/**
 * OtpService — issues and verifies one-time codes. This is the ONLY thing that
 * authorises a transaction to complete (see `no-otp-no-money`). Codes are hashed
 * at rest (never stored or logged in the clear) with a 5-minute expiry and a
 * 3-attempt limit.
 */
@Injectable()
export class OtpService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private hash(code: string, userId: string): string {
    return createHash('sha256').update(`${code}:${userId}`).digest('hex');
  }

  /** Issue a 6-digit code for a user/transaction. Returns the plaintext code to deliver. */
  async issue(userId: string, transactionId: string, purpose = 'payment'): Promise<string> {
    // Invalidate any earlier open codes for this user so only the newest is valid.
    await this.pool.query(
      'update public.otp_challenges set consumed_at = now() where user_id = $1 and consumed_at is null',
      [userId],
    );
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.pool.query(
      `insert into public.otp_challenges (user_id, transaction_id, purpose, code_hash, expires_at)
       values ($1, $2, $3, $4, now() + interval '5 minutes')`,
      [userId, transactionId, purpose, this.hash(code, userId)],
    );
    return code;
  }

  /** Verify a code. Returns the linked transaction id on success. */
  async verify(userId: string, code: string): Promise<OtpVerifyResult> {
    const { rows } = await this.pool.query<OtpRow>(
      `select id, transaction_id, code_hash, attempts, max_attempts
       from public.otp_challenges
       where user_id = $1 and consumed_at is null and expires_at > now()
       order by created_at desc limit 1`,
      [userId],
    );
    const challenge = rows[0];
    if (!challenge) return { ok: false, reason: 'no_active_code' };

    if (challenge.attempts >= challenge.max_attempts) {
      await this.consume(challenge.id);
      return { ok: false, reason: 'too_many_attempts' };
    }

    const provided = Buffer.from(this.hash(code.trim(), userId), 'hex');
    const expected = Buffer.from(challenge.code_hash, 'hex');
    const match = provided.length === expected.length && timingSafeEqual(provided, expected);

    if (match) {
      await this.consume(challenge.id);
      return { ok: true, transactionId: challenge.transaction_id };
    }

    const attempts = challenge.attempts + 1;
    if (attempts >= challenge.max_attempts) {
      await this.consume(challenge.id);
    } else {
      await this.pool.query('update public.otp_challenges set attempts = $1 where id = $2', [
        attempts,
        challenge.id,
      ]);
    }
    return { ok: false, reason: 'wrong_code' };
  }

  private async consume(id: string): Promise<void> {
    await this.pool.query('update public.otp_challenges set consumed_at = now() where id = $1', [id]);
  }
}
