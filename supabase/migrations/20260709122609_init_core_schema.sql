-- GuildPay AI — core schema (M2)
-- Conversational neobank: users, multi-currency wallets, double-entry ledger,
-- transactions, beneficiaries, OTP challenges, audit trail.
-- Aligned to packages/shared (Currency NGN|QAR, Market NG|QA, Intent/TransactionType).
--
-- Security: RLS is enabled on every table and NO anon/authenticated policies are
-- created — these tables are backend-only. The API reaches them via the Postgres
-- role (direct connection) / service_role, both of which bypass RLS. As of
-- 2026-04-28 new public tables are also not auto-exposed to the Data API.
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS, ENABLE RLS is a no-op).

-- updated_at helper
create or replace function public.set_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── users ────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id              uuid primary key default gen_random_uuid(),
  wa_phone        text unique not null,                         -- E.164
  full_name       text,
  language        text not null default 'en'
                    check (language in ('en','pidgin','ar')),
  market          text not null check (market in ('NG','QA')),
  currency        text not null check (currency in ('NGN','QAR')),
  kyc_id          text,                                         -- BVN (NG) / QID (QA); store masked in UI
  kyc_expiry      date,
  consent_at      timestamptz,
  pin_hash        text,                                         -- argon2id
  status          text not null default 'pending'
                    check (status in ('pending','active','frozen','closed')),
  onboarding_step text not null default 'start',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ── wallets ──────────────────────────────────────────────────────────────────
create table if not exists public.wallets (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.users(id) on delete cascade,
  reference              text unique not null,                  -- e.g. GPA-NG-000123
  currency               text not null check (currency in ('NGN','QAR')),
  market                 text not null check (market in ('NG','QA')),
  balance                numeric(14,2) not null default 0,      -- denormalized; ledger is source of truth
  status                 text not null default 'active'
                           check (status in ('active','frozen')),
  virtual_account_number text,                                  -- NUBAN (NG); null for QAR
  virtual_bank_name      text,
  daily_limit            numeric(14,2) not null default 200000,
  txn_limit              numeric(14,2) not null default 50000,
  created_at             timestamptz not null default now(),
  unique (user_id, currency)
);
create index if not exists wallets_user_id_idx on public.wallets(user_id);
create index if not exists wallets_van_idx on public.wallets(virtual_account_number);

-- ── transactions ─────────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references public.wallets(id),
  type            text not null check (type in (
                    'funding','p2p_transfer','bank_transfer','airtime','data',
                    'bill_payment','savings_deposit','savings_withdrawal','refund')),
  channel         text not null check (channel in ('text','voice','image','admin','system')),
  status          text not null default 'draft' check (status in (
                    'draft','pending_confirmation','pending_otp','completed',
                    'failed','cancelled','expired')),
  amount          numeric(14,2) not null,
  fee             numeric(14,2) not null default 0,
  currency        text not null check (currency in ('NGN','QAR')),
  recipient_name  text,
  recipient_ref   text,
  bank_code       text,
  phone_number    text,
  network         text,
  biller_id       text,
  customer_id     text,
  purpose         text,
  ai_extraction   jsonb,                                        -- raw validated LLM extraction
  provider_ref    text,                                         -- Flutterwave / provider reference
  source_media_id text,
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists transactions_wallet_id_idx on public.transactions(wallet_id);
create index if not exists transactions_status_idx on public.transactions(status);
create index if not exists transactions_created_at_idx on public.transactions(created_at desc);

-- ── ledger_entries (double-entry, append-only) ───────────────────────────────
create table if not exists public.ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references public.transactions(id),
  wallet_id      uuid not null references public.wallets(id),
  direction      text not null check (direction in ('debit','credit')),
  amount         numeric(14,2) not null check (amount > 0),
  balance_after  numeric(14,2) not null,
  created_at     timestamptz not null default now()
);
create index if not exists ledger_wallet_id_idx on public.ledger_entries(wallet_id);
create index if not exists ledger_transaction_id_idx on public.ledger_entries(transaction_id);

-- ── beneficiaries ────────────────────────────────────────────────────────────
create table if not exists public.beneficiaries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  alias      text,
  name       text not null,                                     -- verified via name enquiry for bank beneficiaries
  ref        text not null,                                     -- account number or GuildPay ref
  bank_code  text,
  currency   text not null check (currency in ('NGN','QAR')),
  created_at timestamptz not null default now(),
  unique (user_id, ref, bank_code)
);
create index if not exists beneficiaries_user_id_idx on public.beneficiaries(user_id);

-- ── otp_challenges ───────────────────────────────────────────────────────────
create table if not exists public.otp_challenges (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  transaction_id uuid references public.transactions(id),
  purpose        text not null check (purpose in ('payment','pin_change','freeze','login')),
  code_hash      text not null,
  expires_at     timestamptz not null,
  attempts       int not null default 0,
  max_attempts   int not null default 3,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists otp_user_id_idx on public.otp_challenges(user_id);
create index if not exists otp_transaction_id_idx on public.otp_challenges(transaction_id);

-- ── audit_events ─────────────────────────────────────────────────────────────
create table if not exists public.audit_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.users(id),
  actor      text not null default 'system' check (actor in ('user','system','admin')),
  action     text not null,
  entity     text,
  entity_id  text,
  metadata   jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_user_id_idx on public.audit_events(user_id);
create index if not exists audit_created_at_idx on public.audit_events(created_at desc);

-- updated_at triggers
drop trigger if exists set_users_updated_at on public.users;
create trigger set_users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists set_transactions_updated_at on public.transactions;
create trigger set_transactions_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- Row Level Security: enable on all tables; backend-only (no anon/authenticated policies).
alter table public.users          enable row level security;
alter table public.wallets        enable row level security;
alter table public.transactions   enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.beneficiaries  enable row level security;
alter table public.otp_challenges enable row level security;
alter table public.audit_events   enable row level security;
