-- GuildPay AI — fields captured by the Xara-style multi-screen onboarding Flow.
-- The native WhatsApp modal collects an ID type (BVN/NIN), a postal address, and
-- an optional referral code in addition to the name/ID already stored. Idempotent.

alter table public.users
  add column if not exists id_type        text,
  add column if not exists address_street text,
  add column if not exists address_city   text,
  add column if not exists address_state  text,
  add column if not exists referral_code  text;

do $$ begin
  alter table public.users
    add constraint users_id_type_check check (id_type in ('BVN','NIN','QID'));
exception when duplicate_object then null; end $$;
