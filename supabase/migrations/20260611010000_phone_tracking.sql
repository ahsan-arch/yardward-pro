-- =============================================================================
-- Phone-based vehicle tracking + manual odometer feed.
--
-- Makes GeoTab droppable: the driver app pings the driver's phone GPS while
-- a shift is open, and the existing Live map / vehicle_locations history /
-- prolonged-stop machinery keep working from the same columns the Geotab
-- cron used to write. Tradeoff (documented in the UI): tracking follows the
-- driver's phone, not the truck's hardware — coverage is "while clocked in
-- with the app", not 24/7.
--
--   - record_driver_location(): SECURITY DEFINER so drivers (who have no
--     UPDATE grant on vehicles) can write their own assigned vehicle's live
--     position. Guards: must be authenticated, must have an assigned
--     vehicle, must have an OPEN shift (clocked in), sane lat/lng.
--   - record_vehicle_odometer(): start-of-day odometer entry becomes the
--     vehicle's odometer (monotonic guard — refuses to wind it backwards),
--     which is what preventive-maintenance-check reads. Replaces the Geotab
--     odometer feed with the number drivers already type every morning.
-- =============================================================================

create or replace function public.record_driver_location(
  p_lat double precision,
  p_lng double precision,
  p_speed_kmh double precision default null
)
returns table (ok boolean, vehicle_id text, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vehicle_id text;
  v_open_shift boolean;
begin
  if auth.uid() is null then
    ok := false; vehicle_id := null; error := 'not authenticated';
    return next; return;
  end if;
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    ok := false; vehicle_id := null; error := 'invalid coordinates';
    return next; return;
  end if;

  select v.id into v_vehicle_id
    from public.vehicles v
   where v.driver_id = auth.uid()
   limit 1;
  if v_vehicle_id is null then
    ok := false; vehicle_id := null; error := 'no vehicle assigned';
    return next; return;
  end if;

  select exists (
    select 1 from public.time_entries te
     where te.driver_id = auth.uid() and te.clock_out is null
  ) into v_open_shift;
  if not v_open_shift then
    ok := false; vehicle_id := v_vehicle_id; error := 'no open shift';
    return next; return;
  end if;

  insert into public.vehicle_locations
    (vehicle_id, geotab_device_id, latitude, longitude, speed_kmh, is_driving, recorded_at)
  values
    (v_vehicle_id, null, p_lat, p_lng, p_speed_kmh,
     coalesce(p_speed_kmh, 0) > 3, now());

  update public.vehicles
     set latitude            = p_lat,
         longitude           = p_lng,
         speed_kmh           = p_speed_kmh,
         speed_mph           = case when p_speed_kmh is null then null else round((p_speed_kmh * 0.621371)::numeric, 1) end,
         is_driving          = coalesce(p_speed_kmh, 0) > 3,
         last_seen_at        = now(),
         location_updated_at = now()
   where id = v_vehicle_id;

  ok := true; vehicle_id := v_vehicle_id; error := null;
  return next;
end;
$$;

revoke all on function public.record_driver_location(double precision, double precision, double precision) from public;
revoke all on function public.record_driver_location(double precision, double precision, double precision) from anon;
grant execute on function public.record_driver_location(double precision, double precision, double precision) to authenticated;
grant execute on function public.record_driver_location(double precision, double precision, double precision) to service_role;

create or replace function public.record_vehicle_odometer(p_odometer integer)
returns table (ok boolean, vehicle_id text, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vehicle_id text;
  v_current integer;
begin
  if auth.uid() is null then
    ok := false; vehicle_id := null; error := 'not authenticated';
    return next; return;
  end if;
  if p_odometer is null or p_odometer < 0 or p_odometer > 5000000 then
    ok := false; vehicle_id := null; error := 'odometer out of range';
    return next; return;
  end if;

  select v.id, v.odometer into v_vehicle_id, v_current
    from public.vehicles v
   where v.driver_id = auth.uid()
   limit 1;
  if v_vehicle_id is null then
    ok := false; vehicle_id := null; error := 'no vehicle assigned';
    return next; return;
  end if;

  -- Monotonic: a typo'd low reading must not rewind the maintenance clock.
  if p_odometer >= coalesce(v_current, 0) then
    update public.vehicles set odometer = p_odometer where id = v_vehicle_id;
  end if;

  ok := true; vehicle_id := v_vehicle_id; error := null;
  return next;
end;
$$;

revoke all on function public.record_vehicle_odometer(integer) from public;
revoke all on function public.record_vehicle_odometer(integer) from anon;
grant execute on function public.record_vehicle_odometer(integer) to authenticated;
grant execute on function public.record_vehicle_odometer(integer) to service_role;

-- ---- Standalone invoicing columns (QuickBooks-optional operation) -----------
alter table public.invoice_data
  add column if not exists sent_at timestamptz,
  add column if not exists sent_to text,
  add column if not exists paid_at timestamptz,
  add column if not exists paid_note text not null default '';
