-- Close the last QuickBooks-dependency gaps for daily operations:
--   - drivers.hourly_rate: per-driver pay rate so the Payroll CSV exports
--     GROSS PAY, not just hours — the accountant gets a finished artifact.
--   - engine-hours accrual: shifts now accrue vehicles.engine_hours from
--     clocked time (replaces the Geotab engine-hours feed for preventive
--     maintenance once hardware tracking is dropped).

alter table public.drivers
  add column if not exists hourly_rate numeric(8,2) not null default 0;

-- Accrue engine hours on clock-out: shift duration (capped at 24h for
-- sanity) is added to the assigned vehicle's engine_hours. Conservative —
-- counts on-shift time as engine time, which for a vac truck on site is
-- close to reality and errs toward EARLIER maintenance, never later.
create or replace function public.accrue_engine_hours()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hours numeric;
begin
  if new.clock_out is not null and old.clock_out is null then
    v_hours := least(extract(epoch from (new.clock_out - new.clock_in)) / 3600.0, 24);
    if v_hours > 0 then
      update public.vehicles
         set engine_hours = coalesce(engine_hours, 0) + round(v_hours::numeric, 1)
       where driver_id = new.driver_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists time_entries_accrue_engine_hours on public.time_entries;
create trigger time_entries_accrue_engine_hours
  after update on public.time_entries
  for each row execute function public.accrue_engine_hours();
