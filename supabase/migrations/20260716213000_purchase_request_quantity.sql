-- =============================================================================
-- Quantity field on purchase requests.
--
-- Client feedback: "New Purchase Request doesn't have a quantity field" — the
-- form only asked for item/reason/cost/urgency, so there was no way to record
-- how many units a mechanic actually needed. This is also the missing input
-- for the "stock says 2 but I need 4" correlation the client asked about
-- separately (a follow-up fix to the approval reservation logic, which today
-- always reserves exactly 1 unit regardless of what was requested).
-- =============================================================================

alter table public.purchase_requests
  add column if not exists quantity integer not null default 1 check (quantity > 0);

comment on column public.purchase_requests.quantity is
  'Units requested by the mechanic. Default 1 for legacy rows created before this column existed.';

notify pgrst, 'reload schema';
