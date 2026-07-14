-- GuildPay AI — comprehensive onboarding + KYC status + provider account ref.
-- Adds the profile fields Flutterwave needs for a permanent NUBAN (email, split
-- name), a KYC lifecycle status, and the provider account reference on wallets.
-- Idempotent: safe to re-run.

alter table public.users
  add column if not exists email       text,
  add column if not exists first_name  text,
  add column if not exists last_name   text,
  add column if not exists kyc_status  text not null default 'pending';

do $$ begin
  alter table public.users
    add constraint users_kyc_status_check check (kyc_status in ('pending','verified','failed'));
exception when duplicate_object then null; end $$;

create index if not exists users_email_idx on public.users(email);

-- Flutterwave order_ref / provider reference for the provisioned virtual account.
alter table public.wallets
  add column if not exists virtual_account_ref text;
