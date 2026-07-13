import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.constants';

export class InsufficientFundsError extends Error {
  constructor() {
    super('insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

/**
 * WalletService — the single source of truth for balances via the double-entry
 * ledger. All balance math happens in Postgres NUMERIC inside a transaction, so
 * there are no floating-point rounding bugs and no partial writes.
 */
@Injectable()
export class WalletService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getBalance(walletId: string): Promise<string> {
    const { rows } = await this.pool.query<{ balance: string }>(
      'select balance from public.wallets where id = $1',
      [walletId],
    );
    return rows[0]?.balance ?? '0';
  }

  /** Credit a wallet (e.g. demo funding). Atomic: balance + ledger entry. */
  async credit(walletId: string, amount: number, transactionId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query<{ balance: string }>(
        'update public.wallets set balance = balance + $1 where id = $2 returning balance',
        [amount, walletId],
      );
      const balanceAfter = rows[0]!.balance;
      await client.query(
        `insert into public.ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
         values ($1, $2, 'credit', $3, $4)`,
        [transactionId, walletId, amount, balanceAfter],
      );
      await client.query('commit');
      return balanceAfter;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Move money between two wallets. Atomic double-entry: the conditional debit
   * both locks the sender row and enforces sufficient funds in one statement.
   */
  async transfer(
    fromWalletId: string,
    toWalletId: string,
    amount: number,
    transactionId: string,
  ): Promise<{ fromBalance: string; toBalance: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const debit = await client.query<{ balance: string }>(
        `update public.wallets set balance = balance - $1
         where id = $2 and balance >= $1 returning balance`,
        [amount, fromWalletId],
      );
      if (debit.rowCount === 0) {
        await client.query('rollback');
        throw new InsufficientFundsError();
      }
      const fromBalance = debit.rows[0]!.balance;
      await client.query(
        `insert into public.ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
         values ($1, $2, 'debit', $3, $4)`,
        [transactionId, fromWalletId, amount, fromBalance],
      );

      const credit = await client.query<{ balance: string }>(
        'update public.wallets set balance = balance + $1 where id = $2 returning balance',
        [amount, toWalletId],
      );
      const toBalance = credit.rows[0]!.balance;
      await client.query(
        `insert into public.ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
         values ($1, $2, 'credit', $3, $4)`,
        [transactionId, toWalletId, amount, toBalance],
      );

      await client.query('commit');
      return { fromBalance, toBalance };
    } catch (err) {
      if ((err as Error).name !== 'InsufficientFundsError') {
        await client.query('rollback').catch(() => undefined);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
