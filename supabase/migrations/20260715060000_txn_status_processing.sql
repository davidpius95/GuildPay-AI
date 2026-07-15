-- Add 'processing' to the transaction status lifecycle. A NIP payout accepted by
-- Flutterwave but not yet settled is 'processing' until the transfer.completed
-- webhook confirms ('completed') or fails ('failed', which reverses the debit).
-- Idempotent.

alter table public.transactions drop constraint if exists transactions_status_check;
alter table public.transactions add constraint transactions_status_check check (status in (
  'draft','pending_confirmation','pending_otp','processing','completed',
  'failed','cancelled','expired'));
