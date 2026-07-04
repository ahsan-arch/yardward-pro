-- Fix: preventive-maintenance alerts never fire.
--
-- The ENTIRE codebase treats vehicles.next_service_due as free text — e.g.
-- "90,000 km", "5,800 hrs", "Service overdue" (see src/data/mockData.ts,
-- src/lib/db-mappers.ts, src/lib/database.types.ts which types it `string | null`,
-- and supabase/functions/preventive-maintenance-check which parses the leading
-- number + unit). But the initial schema declared the column `date`, so:
--   1. the PM parser never matched a date value → no service alert could ever
--      fire (the audit's blocker), and
--   2. writing a real "90,000 km" value from the UI would fail the date cast.
--
-- Align the actual column type with how every consumer already uses it. The
-- `using next_service_due::text` cast is identity if the column is already text
-- (idempotent / safe to re-run), and converts any stray date values to their
-- ISO text form (those simply read as "unparseable" in the PM check until an
-- operator re-enters a "<n> km/hrs" value, instead of silently skipping ALL
-- vehicles as today).
alter table public.vehicles
  alter column next_service_due type text
  using next_service_due::text;
