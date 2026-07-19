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

export interface UserRow {
  id: string;
  wa_phone: string;
  full_name: string | null;
  email: string | null;
  market: string | null;
  status: string;
  kyc_status: string;
  onboarding_step: string;
  created_at: string;
  wallet_ref: string | null;
  balance: string | null;
  currency: string | null;
  virtual_account_number: string | null;
  virtual_bank_name: string | null;
}

export async function getUsers(): Promise<UserRow[]> {
  return query<UserRow>(
    `select u.id, u.wa_phone, u.full_name, u.email, u.market, u.status, u.kyc_status,
            u.onboarding_step, u.created_at,
            w.reference as wallet_ref, w.balance::text as balance, w.currency,
            w.virtual_account_number, w.virtual_bank_name
     from public.users u
     left join public.wallets w on w.user_id = u.id
     order by u.created_at desc
     limit 200`,
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

// ── Filtered / paginated transactions list ────────────────────────────────────

export interface TxnFilter {
  q?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}

export interface TxnPage {
  rows: Txn[];
  total: number;
  page: number;
  pageSize: number;
}

export async function searchTransactions(f: TxnFilter): Promise<TxnPage> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = f.pageSize ?? 40;
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`t.status = $${params.length}`);
  }
  if (f.type) {
    params.push(f.type);
    where.push(`t.type = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(
      `(t.recipient_name ilike ${p} or t.recipient_ref ilike ${p} or t.provider_ref ilike ${p} or w.reference ilike ${p})`,
    );
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  const [countRow] = await query<{ total: number }>(
    `select count(*)::int as total
     from public.transactions t left join public.wallets w on w.id = t.wallet_id ${clause}`,
    params,
  );
  const rows = await query<Txn>(
    `select t.id, t.type, t.status, t.amount::text, t.currency, t.recipient_name, t.channel,
            t.created_at, w.reference as wallet_ref
     from public.transactions t left join public.wallets w on w.id = t.wallet_id ${clause}
     order by t.created_at desc
     limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  return { rows, total: countRow?.total ?? 0, page, pageSize };
}

// ── Transaction detail (txn + ledger + audit) ────────────────────────────────

export interface TxnDetail extends Txn {
  fee: string;
  recipient_ref: string | null;
  bank_code: string | null;
  provider_ref: string | null;
  purpose: string | null;
  confirmed_at: string | null;
  user_id: string | null;
  user_name: string | null;
  wallet_id: string | null;
}

export async function getTransactionDetail(id: string): Promise<TxnDetail | null> {
  const [row] = await query<TxnDetail>(
    `select t.id, t.type, t.status, t.amount::text, t.fee::text, t.currency,
            t.recipient_name, t.recipient_ref, t.bank_code, t.provider_ref, t.purpose,
            t.channel, t.created_at, t.confirmed_at,
            w.id as wallet_id, w.reference as wallet_ref, u.id as user_id, u.full_name as user_name
     from public.transactions t
     left join public.wallets w on w.id = t.wallet_id
     left join public.users u on u.id = w.user_id
     where t.id = $1`,
    [id],
  );
  return row ?? null;
}

export interface LedgerEntry {
  id: string;
  direction: string;
  amount: string;
  balance_after: string;
  description: string | null;
  reference: string | null;
  created_at: string;
}

export async function getLedgerForTransaction(txnId: string): Promise<LedgerEntry[]> {
  return query<LedgerEntry>(
    `select id::text, direction, amount::text, balance_after::text, description, reference, created_at
     from public.ledger_entries where transaction_id = $1 order by id asc`,
    [txnId],
  );
}

// ── Audit events ─────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  user_id: string | null;
  actor: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  metadata: unknown;
  created_at: string;
  user_name: string | null;
}

export interface AuditFilter {
  actor?: string;
  action?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditPage {
  rows: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAuditEvents(f: AuditFilter): Promise<AuditPage> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = f.pageSize ?? 50;
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.actor) {
    params.push(f.actor);
    where.push(`a.actor = $${params.length}`);
  }
  if (f.action) {
    params.push(`%${f.action}%`);
    where.push(`a.action ilike $${params.length}`);
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  const [countRow] = await query<{ total: number }>(
    `select count(*)::int as total from public.audit_events a ${clause}`,
    params,
  );
  const rows = await query<AuditEvent>(
    `select a.id::text, a.user_id, a.actor, a.action, a.entity, a.entity_id, a.metadata,
            a.created_at, u.full_name as user_name
     from public.audit_events a
     left join public.users u on u.id = a.user_id ${clause}
     order by a.id desc
     limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  );
  return { rows, total: countRow?.total ?? 0, page, pageSize };
}

export async function getAuditForEntity(entityId: string, limit = 20): Promise<AuditEvent[]> {
  return query<AuditEvent>(
    `select a.id::text, a.user_id, a.actor, a.action, a.entity, a.entity_id, a.metadata,
            a.created_at, u.full_name as user_name
     from public.audit_events a
     left join public.users u on u.id = a.user_id
     where a.entity_id = $1 order by a.id desc limit $2`,
    [entityId, limit],
  );
}

// ── User detail (profile + wallet + activity) ────────────────────────────────

export async function getUser(id: string): Promise<UserRow | null> {
  const [row] = await query<UserRow>(
    `select u.id, u.wa_phone, u.full_name, u.email, u.market, u.status, u.kyc_status,
            u.onboarding_step, u.created_at,
            w.reference as wallet_ref, w.balance::text as balance, w.currency,
            w.virtual_account_number, w.virtual_bank_name
     from public.users u
     left join public.wallets w on w.user_id = u.id
     where u.id = $1`,
    [id],
  );
  return row ?? null;
}

export async function getUserTransactions(userId: string, limit = 25): Promise<Txn[]> {
  return query<Txn>(
    `select t.id, t.type, t.status, t.amount::text, t.currency, t.recipient_name, t.channel,
            t.created_at, w.reference as wallet_ref
     from public.transactions t
     join public.wallets w on w.id = t.wallet_id
     where w.user_id = $1
     order by t.created_at desc
     limit $2`,
    [userId, limit],
  );
}

export interface Beneficiary {
  id: string;
  name: string;
  ref: string;
  bank_code: string | null;
  currency: string;
  created_at: string;
}

export async function getUserBeneficiaries(userId: string): Promise<Beneficiary[]> {
  return query<Beneficiary>(
    `select id, name, ref, bank_code, currency, created_at
     from public.beneficiaries where user_id = $1 order by created_at desc`,
    [userId],
  );
}

export async function getUserAudit(userId: string, limit = 25): Promise<AuditEvent[]> {
  return query<AuditEvent>(
    `select id::text, user_id, actor, action, entity, entity_id, metadata, created_at,
            null::text as user_name
     from public.audit_events where user_id = $1 order by id desc limit $2`,
    [userId, limit],
  );
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface TxnTypeStat {
  type: string;
  count: number;
  volume: string;
}

export async function getVolumeByType(): Promise<TxnTypeStat[]> {
  return query<TxnTypeStat>(
    `select type, count(*)::int as count,
            coalesce(sum(amount) filter (where status = 'completed'), 0)::text as volume
     from public.transactions group by type order by count desc`,
  );
}

export interface StatusStat {
  status: string;
  count: number;
}

export async function getStatusBreakdown(): Promise<StatusStat[]> {
  return query<StatusStat>(
    `select status, count(*)::int as count from public.transactions group by status order by count desc`,
  );
}

export interface FunnelStep {
  onboarding_step: string;
  count: number;
}

export async function getOnboardingFunnel(): Promise<FunnelStep[]> {
  return query<FunnelStep>(
    `select onboarding_step, count(*)::int as count
     from public.users group by onboarding_step order by count desc`,
  );
}

export interface RevenueStat {
  currency: string;
  fees: string;
  volume: string;
  completed: number;
}

export async function getRevenueByCurrency(): Promise<RevenueStat[]> {
  return query<RevenueStat>(
    `select currency,
            coalesce(sum(fee) filter (where status = 'completed'), 0)::text as fees,
            coalesce(sum(amount) filter (where status = 'completed'), 0)::text as volume,
            count(*) filter (where status = 'completed')::int as completed
     from public.transactions group by currency order by currency`,
  );
}

export interface TopRecipient {
  recipient_name: string | null;
  recipient_ref: string | null;
  count: number;
  volume: string;
}

export async function getTopRecipients(limit = 8): Promise<TopRecipient[]> {
  return query<TopRecipient>(
    `select recipient_name, recipient_ref, count(*)::int as count,
            coalesce(sum(amount), 0)::text as volume
     from public.transactions
     where status = 'completed' and (recipient_name is not null or recipient_ref is not null)
     group by recipient_name, recipient_ref
     order by count desc, volume desc
     limit $1`,
    [limit],
  );
}
