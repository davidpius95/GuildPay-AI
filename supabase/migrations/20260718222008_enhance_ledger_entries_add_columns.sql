-- Enhance the double-entry ledger with banking fields: currency, description, reference.
--
-- Idempotent (add column if not exists) and applied to production with defaults kept,
-- so code that predated these columns kept working during rollout (expand phase). The
-- defaults are intentionally retained: all money-movement code in WalletService always
-- supplies currency + description, so the defaults are only a safety net for legacy /
-- backfilled rows. If strict enforcement is ever wanted, a separate follow-up migration
-- can `alter column ... drop default` — only once every deployed code path provides the
-- values (it does today).
--
-- Version matches the record in the remote migration history
-- (supabase_migrations: 20260718222008 enhance_ledger_entries_add_columns).

alter table public.ledger_entries
  add column if not exists currency    text not null default 'NGN',
  add column if not exists description  text not null default 'Legacy transaction',
  add column if not exists reference    text;
