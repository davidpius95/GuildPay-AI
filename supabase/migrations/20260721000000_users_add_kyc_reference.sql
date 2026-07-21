-- GuildPay AI — BVN consent verification reference.
-- Flutterwave's BVN verification is a consent flow: we start it, the user approves
-- with their bank, and the result arrives asynchronously on the
-- `bvn.verification.completed` webhook. `kyc_reference` stores the provider's
-- verification reference so that webhook can be correlated back to the user who
-- started it. Safe to store/audit (it is not the raw BVN). Idempotent.

alter table public.users
  add column if not exists kyc_reference text;

comment on column public.users.kyc_reference is
  'Provider reference for an in-flight BVN consent verification; correlates the bvn.verification.completed webhook to the user.';

create index if not exists users_kyc_reference_idx on public.users(kyc_reference);
