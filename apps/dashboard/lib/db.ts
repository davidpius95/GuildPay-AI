import 'server-only';
import { Pool } from 'pg';

/**
 * Read-only Postgres access for the admin dashboard (server components only).
 * Reuses a single pool across hot-reloads via a global. Same Supabase DB as the API.
 */
const globalForPg = globalThis as unknown as { guildpayPool?: Pool };

export const pool =
  globalForPg.guildpayPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });

if (process.env.NODE_ENV !== 'production') globalForPg.guildpayPool = pool;

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}
