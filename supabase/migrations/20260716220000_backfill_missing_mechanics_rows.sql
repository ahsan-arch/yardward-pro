-- =============================================================================
-- Backfill: mechanics onboarded via admin-create-user's fresh-create path
-- never got a row in public.mechanics — that insert was missing (fixed
-- alongside this migration). Every purchase_requests insert FKs mechanic_id
-- to mechanics.id (not profiles.id), so any mechanic missing this row got a
-- foreign-key violation the instant they tried to submit a purchase
-- request. Client feedback: "Tried to submit filter order but got errors."
--
-- Idempotent: only inserts profiles with role='mechanic' that don't already
-- have a mechanics row. Safe to re-run.
-- =============================================================================

insert into public.mechanics (id)
select p.id
from public.profiles p
where p.role = 'mechanic'
  and not exists (select 1 from public.mechanics m where m.id = p.id);
