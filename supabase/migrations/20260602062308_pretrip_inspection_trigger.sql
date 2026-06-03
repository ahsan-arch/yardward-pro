-- After a passing vehicle_inspection insert, stamp vehicles.last_pretrip_at = now()
-- automatically. This moves the pre-trip lockout enforcement to the database
-- layer so drivers (who only have INSERT on vehicle_inspections, not UPDATE on
-- vehicles) can still complete the workflow without RLS friction, and so the
-- 12h lockout window can't be bypassed by a client tampering with the api call.

create or replace function public.trg_vehicles_set_last_pretrip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only PASSING (non-flagged) inspections lift the lockout. Failed walk-arounds
  -- still record a row for the audit trail but don't reset the timer.
  if NEW.flagged = false then
    update public.vehicles
       set last_pretrip_at = now()
     where id = NEW.vehicle_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists vehicle_inspections_update_last_pretrip on public.vehicle_inspections;
create trigger vehicle_inspections_update_last_pretrip
  after insert on public.vehicle_inspections
  for each row
  execute function public.trg_vehicles_set_last_pretrip();

-- Also: a backfill so any inspections submitted just before this migration
-- (we have one from the smoke test, INS-ZJQI3M) get their corresponding
-- vehicle stamped too. Idempotent — only stamps when not already set.
update public.vehicles v
   set last_pretrip_at = sub.last_pass
  from (
    select vehicle_id, max(submitted_at) as last_pass
      from public.vehicle_inspections
     where flagged = false
     group by vehicle_id
  ) sub
 where v.id = sub.vehicle_id
   and v.last_pretrip_at is null;
