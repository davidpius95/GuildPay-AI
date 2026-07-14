import 'server-only';
import { query } from './db';

export interface Overview {
  users: number;
  wallets: number;
  activeUsers: number;
  txnCount: number;
}

export async function getOverview(): Promise<Overview> {
  const [row] = await query<Overview>(
    `select
       (select count(*)::int from public.users)                              as "users",
       (select count(*)::int from public.users where status = 'active')      as "activeUsers",
       (select count(*)::int from public.wallets)                            as "wallets",
       (select count(*)::int from public.transactions)                       as "txnCount"`,
  );
  return row ?? { users: 0, wallets: 0, activeUsers: 0, txnCount: 0 };
}

export interface CurrencyStat {
  currency: string;
  wallets: number;
  balance: string;
}

export async function getBalancesByCurrency(): Promise<CurrencyStat[]> {
  return query<CurrencyStat>(
    `select currency, count(*)::int as wallets, coalesce(sum(balance), 0)::text as balance
     from public.wallets group by currency order by currency`,
  );
}

export interface VolumePoint {
  day: string;
  completed: number;
  volume: string;
}

export async function getVolumeLast7Days(): Promise<VolumePoint[]> {
  return query<VolumePoint>(
    `select to_char(d.day, 'Mon DD') as day,
            coalesce(t.completed, 0)::int as completed,
            coalesce(t.volume, 0)::text as volume
     from generate_series(current_date - interval '6 days', current_date, interval '1 day') as d(day)
     left join (
       select date_trunc('day', created_at)::date as day,
              count(*) filter (where status = 'completed') as completed,
              sum(amount) filter (where status = 'completed') as volume
       from public.transactions group by 1
     ) t on t.day = d.day::date
     order by d.day`,
  );
}

export interface Txn {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  recipient_name: string | null;
  channel: string;
  created_at: string;
  wallet_ref: string | null;
}

export async function getRecentTransactions(limit = 40): Promise<Txn[]> {
  return query<Txn>(
    `select t.id, t.type, t.status, t.amount::text, t.currency, t.recipient_name, t.channel,
            t.created_at, w.reference as wallet_ref
     from public.transactions t
     left join public.wallets w on w.id = t.wallet_id
     order by t.created_at desc
     limit $1`,
    [limit],
  );
}
