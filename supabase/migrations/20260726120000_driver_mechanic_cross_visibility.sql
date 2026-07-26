-- =============================================================================
-- Driver <-> mechanic cross-visibility for messaging + vehicle inspection
--
-- Found during a full QA sweep (2026-07-26): RLS on profiles/drivers/
-- mechanics/vehicles was scoped to "read your own row only", which is
-- correct for sensitive per-user data but too narrow for two legitimate,
-- already-built features that need a roster of the OTHER role:
--
--   1. Communications "New conversation" picker — a driver picking a
--      mechanic to message (driver.messages.tsx) and a mechanic picking a
--      driver (mechanic.messages.tsx) both read useData().mechanics /
--      .drivers, which hydrate from `profiles` (role-filtered) joined with
--      the `drivers`/`mechanics` side tables. With only self-read policies,
--      those queries returned zero rows for the other role every time — the
--      "New conversation" dialog always had an empty picker, for every
--      driver and every mechanic, unconditionally.
--
--   2. Vehicle inspection "Choose vehicle" dropdown (driver.inspection.tsx)
--      reads useData().vehicles, gated by vehicles_driver_read (driver_id =
--      auth.uid()) — a driver with no vehicle currently assigned to them
--      (new hire, reassigned, relief driver) saw zero vehicles and could
--      not complete a pre-trip inspection on ANY truck, soft-locking them
--      out of the app (start-of-day is gated behind a passing inspection).
--
-- Fix: mirror the existing vehicles_mechanic_read pattern (mechanics can
-- already read the whole fleet) by granting drivers the same read, and add
-- symmetric cross-role read policies on profiles/drivers/mechanics so each
-- role's roster picker actually has options. All additive SELECT-only
-- policies — Postgres OR's multiple permissive policies together, so
-- existing self-read/admin-all policies are unaffected. No writes granted.
-- =============================================================================

create policy profiles_driver_read_mechanics on profiles
  for select using (role = 'mechanic' and current_role_value() = 'driver');
create policy profiles_mechanic_read_drivers on profiles
  for select using (role = 'driver' and current_role_value() = 'mechanic');

create policy mechanics_driver_read_all on mechanics
  for select using (current_role_value() = 'driver');
create policy drivers_mechanic_read_all on drivers
  for select using (current_role_value() = 'mechanic');

create policy vehicles_driver_read_fleet on vehicles
  for select using (current_role_value() = 'driver');
