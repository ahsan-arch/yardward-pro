-- =============================================================================
-- Let mechanics open their own maintenance work orders.
--
-- Client feedback (Mechanic Profile item 9): "Work Orders cannot be created."
-- The client is right, and it's deeper than a missing button: even the
-- backend has no path for it. maintenance_work_orders only has RLS INSERT
-- policies for admin (maintenance_wo_admin_all) and for a driver self-
-- flagging their own vehicle (maintenance_wo_driver_insert_own, restricted
-- to reported_from IN ('inspection','driver_note')). A mechanic noticing an
-- issue on the shop floor — the exact scenario the client was testing —
-- has no INSERT policy at all, so even a wired-up "New work order" button
-- would 400 against RLS the instant a mechanic clicked it.
--
-- Adds:
--   1. 'mechanic' to the reported_from check constraint, so a mechanic-
--      opened row is attributable (not lumped in under 'admin').
--   2. maintenance_wo_mechanic_insert_own — mirrors the driver self-insert
--      policy: a mechanic may only insert a row reported_by themselves,
--      tagged reported_from = 'mechanic'. They still can't back-date a
--      status or assign it to someone else — the row lands 'queued' via
--      the column default like every other entry point.
-- =============================================================================

alter table public.maintenance_work_orders
  drop constraint if exists maintenance_work_orders_reported_from_check;

alter table public.maintenance_work_orders
  add constraint maintenance_work_orders_reported_from_check
  check (reported_from in ('inspection', 'admin', 'driver_note', 'mechanic'));

create policy maintenance_wo_mechanic_insert_own
  on public.maintenance_work_orders
  for insert
  with check (
    reported_by = auth.uid()
    and reported_from = 'mechanic'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'mechanic'
    )
  );
