-- Add robust banking fields to ledger_entries

alter table public.ledger_entries
  add column currency text not null default 'NGN',
  add column description text not null default 'Legacy transaction',
  add column reference text;

-- Drop defaults so future inserts are strictly enforced
alter table public.ledger_entries alter column currency drop default;
alter table public.ledger_entries alter column description drop default;
