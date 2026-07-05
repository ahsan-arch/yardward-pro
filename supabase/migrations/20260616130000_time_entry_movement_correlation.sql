-- Fix: time_entries.vehicle_movement_correlation was always 'pending', so the
-- admin GPS-mismatch report and the timesheet correlation column never showed
-- anything (the value was hardcoded in api.ts and nothing ever computed it).
--
-- Compute it server-side from the data we already have: when a shift's clock-in
-- (or, once present, clock-out) GPS is recorded, compare it to the driver's
-- assigned vehicle's last-known position (vehicles.latitude/longitude, fed by
-- the phone-tracking record_driver_location RPC). Within ~750 m → 'matches'
-- (the driver was at their truck); beyond → 'mismatch' (clocked in/out away
-- from the truck — a time-fraud signal an admin reviews on the report).
--
-- Conservative by design: if there is NO vehicle position to compare against we
-- leave the value untouched ('pending'), so the report never shows a false
-- mismatch. The whole computation is wrapped so it can never block a clock-in.

create or replace function public.compute_movement_correlation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lat       double precision;
  v_lng       double precision;
  v_clock_lat double precision;
  v_clock_lng double precision;
  v_dist_m    double precision;
  c_earth_m   constant double precision := 6371000; -- earth radius, metres
  c_thresh_m  constant double precision := 750;      -- match radius, metres
begin
  -- Prefer clock-out GPS once it exists (end-of-shift position), else clock-in.
  v_clock_lat := coalesce(new.gps_clock_out_lat, new.gps_clock_in_lat);
  v_clock_lng := coalesce(new.gps_clock_out_lng, new.gps_clock_in_lng);
  if v_clock_lat is null or v_clock_lng is null then
    return new; -- nothing to correlate against
  end if;

  select v.latitude, v.longitude
    into v_lat, v_lng
    from public.vehicles v
   where v.driver_id = new.driver_id
   limit 1;
  if v_lat is null or v_lng is null then
    return new; -- no known vehicle position; don't guess (stays 'pending')
  end if;

  -- Haversine distance in metres.
  v_dist_m := 2 * c_earth_m * asin(
    sqrt(
      power(sin(radians(v_lat - v_clock_lat) / 2), 2) +
      cos(radians(v_clock_lat)) * cos(radians(v_lat)) *
      power(sin(radians(v_lng - v_clock_lng) / 2), 2)
    )
  );

  new.vehicle_movement_correlation :=
    case when v_dist_m <= c_thresh_m then 'matches' else 'mismatch' end;
  return new;
exception
  when others then
    -- A correlation glitch must never block a driver clocking in/out.
    return new;
end;
$$;

drop trigger if exists trg_time_entries_correlation on public.time_entries;
create trigger trg_time_entries_correlation
  before insert or update of
    gps_clock_in_lat, gps_clock_in_lng, gps_clock_out_lat, gps_clock_out_lng
  on public.time_entries
  for each row
  execute function public.compute_movement_correlation();

comment on function public.compute_movement_correlation() is
  'Sets time_entries.vehicle_movement_correlation to matches/mismatch by '
  'comparing clock GPS to the driver''s assigned vehicle position (~750 m '
  'radius). Leaves it untouched when no vehicle position exists.';
