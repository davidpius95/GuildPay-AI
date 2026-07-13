-- Onboarding creates the user row before the market/currency is chosen, so these
-- become nullable on users. The CHECK constraints still allow NULL. Wallets keep
-- market/currency NOT NULL (a wallet always has a currency).
alter table public.users alter column market drop not null;
alter table public.users alter column currency drop not null;
