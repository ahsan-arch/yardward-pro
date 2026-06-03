-- =============================================================================
-- Add GPS telemetry columns to vehicles + create vehicle_locations history table.
-- Required by the geotab-sync-locations edge function.
-- =============================================================================

alter table vehicles
  add column if not exists latitude               double precision,
  add column if not exists longitude              double precision,
  add column if not exists speed_kmh              double precision,
  add column if not exists speed_mph              double precision,
  add column if not exists bearing                double precision,
  add column if not exists is_device_communicating boolean,
  add column if not exists is_driving             boolean,
  add column if not exists last_seen_at           timestamptz,
  add column if not exists location_updated_at    timestamptz;

-- The edge function upserts on geotab_device_id, so it needs a unique constraint.
-- IS NOT NULL filter so we don't reject the seed rows that haven't been mapped yet.
create unique index if not exists vehicles_geotab_device_id_unique
  on vehicles (geotab_device_id)
  where geotab_device_id is not null;

-- Historical location log so we can replay trips / build breadcrumbs later.
create table if not exists vehicle_locations (
  id               uuid primary key default gen_random_uuid(),
  vehicle_id       text not null references vehicles (id) on delete cascade,
  geotab_device_id text,
  latitude         double precision not null,
  longitude        double precision not null,
  speed_kmh        double precision,
  bearing          double precision,
  is_driving       boolean,
  recorded_at      timestamptz not null
);

create index if not exists vehicle_locations_vehicle_time_idx
  on vehicle_locations (vehicle_id, recorded_at desc);

alter table vehicle_locations enable row level security;
create policy vehicle_locations_admin_all on vehicle_locations
  for all using (is_admin()) with check (is_admin());
create policy vehicle_locations_driver_read on vehicle_locations
  for select using (
    exists (select 1 from vehicles v where v.id = vehicle_locations.vehicle_id and v.driver_id = auth.uid())
  );
