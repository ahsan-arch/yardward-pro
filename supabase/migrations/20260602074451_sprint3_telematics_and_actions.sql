-- =============================================================================
-- Sprint 3: Telematics + action layer (preventive maintenance, prolonged stops,
-- purchase-request fulfillment, inventory touch trigger, fleetio import audit,
-- and the cron schedules that drive the new edge functions).
-- =============================================================================
-- All operations are idempotent (IF NOT EXISTS / IF NOT EXISTS guards / EXISTS-
-- gated unschedule before re-schedule) so re-running this migration is safe.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. app_settings: PM + prolonged-stop thresholds
-- -----------------------------------------------------------------------------
-- service_due_*_warning: how close to next_service_due (km / engine hours) the
-- preventive-maintenance-check edge function should fire a warning at.
-- prolonged_stop_minutes: a stop longer than this DURING a clocked-in shift
-- triggers the prolonged-stop alert.

alter table public.app_settings
  add column if not exists service_due_km_warning    integer not null default 1000,
  add column if not exists service_due_hours_warning integer not null default 50,
  add column if not exists prolonged_stop_minutes    integer not null default 45;


-- -----------------------------------------------------------------------------
-- 2. purchase_request_status enum: ensure 'ordered' exists (between approved
--    and rejected). Already added in the initial schema on fresh installs;
--    the guard makes this safe on older databases.
-- -----------------------------------------------------------------------------
alter type purchase_request_status add value if not exists 'ordered' after 'approved';


-- -----------------------------------------------------------------------------
-- 3. purchase_requests: action-layer columns
-- -----------------------------------------------------------------------------
-- ordered_at / ordered_by:  who flipped status to 'ordered' and when
-- supplier_order_ref:       free-text PO number issued to the supplier
-- inventory_decrement_qty:  units debited from inventory_items.qty_reserved
--                           at approval time, if the request was satisfied
--                           (in part) from stock instead of being ordered.

alter table public.purchase_requests
  add column if not exists ordered_at               timestamptz,
  add column if not exists ordered_by               uuid references public.profiles(id) on delete set null,
  add column if not exists supplier_order_ref       text,
  add column if not exists inventory_decrement_qty  integer;


-- -----------------------------------------------------------------------------
-- 4. inventory_items: last_updated_at + BEFORE UPDATE touch trigger
-- -----------------------------------------------------------------------------
alter table public.inventory_items
  add column if not exists last_updated_at timestamptz not null default now();

create or replace function public.inventory_touch_updated()
returns trigger
language plpgsql
as $$
begin
  new.last_updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_inventory_touch_updated on public.inventory_items;
create trigger trg_inventory_touch_updated
  before update on public.inventory_items
  for each row
  execute function public.inventory_touch_updated();


-- -----------------------------------------------------------------------------
-- 5. pg_cron schedules for the new edge functions
-- -----------------------------------------------------------------------------
-- Both jobs read service_role_key from vault.decrypted_secrets, identical to
-- the existing geotab-sync-every-minute cron, so a single secret rotation
-- updates every scheduled function.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- preventive-maintenance-check: 09:00 UTC daily
select cron.unschedule('preventive-maintenance-check')
where exists (select 1 from cron.job where jobname = 'preventive-maintenance-check');

select cron.schedule(
  'preventive-maintenance-check',
  '0 9 * * *',
  $$
  select net.http_post(
    url     := 'https://pbyeatgjnrhvfnfiublj.supabase.co/functions/v1/preventive-maintenance-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
        ''
      )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- prolonged-stop-check: every 10 minutes
select cron.unschedule('prolonged-stop-check')
where exists (select 1 from cron.job where jobname = 'prolonged-stop-check');

select cron.schedule(
  'prolonged-stop-check',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://pbyeatgjnrhvfnfiublj.supabase.co/functions/v1/prolonged-stop-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
        ''
      )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);


-- -----------------------------------------------------------------------------
-- 6. vehicle_locations: speed_kmh (used by prolonged-stop-check to distinguish
--    a stopped vehicle from a brief gap in telemetry). Already added in the
--    initial telematics migration; guarded so this migration is re-runnable.
-- -----------------------------------------------------------------------------
alter table public.vehicle_locations
  add column if not exists speed_kmh double precision;


-- -----------------------------------------------------------------------------
-- 7. fleetio_imports: audit log for Fleetio sync runs
-- -----------------------------------------------------------------------------
create table if not exists public.fleetio_imports (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('vehicles','maintenance_logs','fuel_logs')),
  imported_count  integer not null default 0,
  skipped_count   integer not null default 0,
  error_count     integer not null default 0,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  last_error      text,
  started_by      uuid references public.profiles(id) on delete set null
);

create index if not exists fleetio_imports_started_at_idx
  on public.fleetio_imports (started_at desc);
create index if not exists fleetio_imports_kind_idx
  on public.fleetio_imports (kind);

alter table public.fleetio_imports enable row level security;

drop policy if exists fleetio_imports_admin_all on public.fleetio_imports;
create policy fleetio_imports_admin_all
  on public.fleetio_imports
  for all
  using (is_admin())
  with check (is_admin());

comment on table public.fleetio_imports is
  'Audit log for Fleetio import runs (vehicles, maintenance_logs, fuel_logs). '
  'One row per invocation of the fleetio-sync edge function; admins inspect '
  'failure counts and last_error for troubleshooting.';
