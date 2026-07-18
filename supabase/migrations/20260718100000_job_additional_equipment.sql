-- =============================================================================
-- Job additional equipment + workshop prep notification.
--
-- Client feedback (Admin Login / Job Menu): "Doesn't have any way to assign
-- additional equipment or to trigger other departments." And, verbatim:
-- "When dispatch selects additional equipment, the responsible department
-- must automatically receive a task to prepare that equipment before the
-- truck leaves the yard."
--
-- additional_equipment is free-text (no formal asset/equipment catalog
-- exists yet — that's a separate, unscoped "Asset Management" ask from the
-- same feedback). Setting it on insert fires one notification per mechanic
-- profile, mirroring the low-stock/PPE trigger pattern.
-- =============================================================================

alter table public.jobs
  add column if not exists additional_equipment text[] not null default '{}';

create or replace function public.notify_mechanics_of_job_equipment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(array_length(new.additional_equipment, 1), 0) = 0 then
    return new;
  end if;

  insert into public.notifications (id, user_id, type, body, link, created_at)
  select
    'NT-' || substr(md5(m.id::text || clock_timestamp()::text), 1, 10),
    m.id,
    'job'::notification_type,
    format(
      'Prepare additional equipment for %s before dispatch: %s',
      new.id,
      array_to_string(new.additional_equipment, ', ')
    ),
    '/mechanic',
    now()
  from public.mechanics m;

  return new;
end;
$$;

drop trigger if exists trg_jobs_notify_equipment_prep on public.jobs;
create trigger trg_jobs_notify_equipment_prep
  after insert on public.jobs
  for each row
  execute function public.notify_mechanics_of_job_equipment();

notify pgrst, 'reload schema';
