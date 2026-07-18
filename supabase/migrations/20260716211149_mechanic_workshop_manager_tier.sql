-- =============================================================================
-- Workshop Manager tier for mechanics.
--
-- Client feedback: the mechanic "Work Orders Assigned to me" view has no way
-- to see the shop's full work-order list — that's a floor-mechanic view, not
-- a manager overview. Rather than fork a new `role` value (which would ripple
-- through every RLS policy keyed on role = 'mechanic'), this adds a same-role
-- tier flag: a Workshop Manager is still role = 'mechanic' (keeps every
-- existing mechanic policy/claim/RPC working unchanged) but additionally sees
-- an "All work orders" tab client-side. No new RLS is needed for that tab —
-- maintenance_wo_mechanic_select already grants every mechanic SELECT over
-- the whole table (the claim queue requires it), so this column only gates
-- the UI, not the data access.
-- =============================================================================

alter table public.profiles
  add column if not exists is_workshop_manager boolean not null default false;

comment on column public.profiles.is_workshop_manager is
  'Mechanic-tier flag: grants the "All work orders" overview tab on /mechanic/work-orders. Meaningless for non-mechanic roles. Written by any admin (unlike is_owner, this is not access-control-sensitive).';

notify pgrst, 'reload schema';
