-- =============================================================================
-- PPE-missing reason capture + admin notification routing.
--
-- Client feedback (Driver item 12): the start-of-day form already had an
-- "Any personal PPE missing?" toggle, but flipping it did nothing — no
-- reason was captured, and the boolean itself was never even included in
-- the submit payload (dead UI). This adds the persisted columns and a
-- trigger that fans the report out to every admin's notification inbox the
-- moment a flagged shift lands.
--
-- The trigger mirrors 20260602062308_pretrip_inspection_trigger.sql: a
-- SECURITY DEFINER function so a driver — who has no write access to
-- notifications (see notifications_admin_all / notifications_self_read /
-- notifications_self_update in 20260601180203_rls_policies.sql) — can still
-- cause an admin notification row to be created, without opening a new
-- client-writable RLS policy that a driver session could otherwise abuse to
-- spam arbitrary notifications at other users.
-- =============================================================================

alter table public.time_entries
  add column if not exists ppe_missing boolean not null default false,
  add column if not exists ppe_missing_reason text not null default '';

create or replace function public.trg_time_entries_notify_ppe_missing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_driver_name text;
begin
  if NEW.ppe_missing then
    select name into v_driver_name from public.profiles where id = NEW.driver_id;
    insert into public.notifications (id, user_id, type, body, link, created_at)
    select
      gen_random_uuid()::text,
      p.id,
      'alert',
      format(
        '%s reported missing PPE at start of shift: %s',
        coalesce(v_driver_name, 'A driver'),
        NEW.ppe_missing_reason
      ),
      '/admin/timesheets',
      now()
    from public.profiles p
    where p.role = 'admin';
  end if;
  return NEW;
end;
$$;

drop trigger if exists time_entries_notify_ppe_missing on public.time_entries;
create trigger time_entries_notify_ppe_missing
  after insert on public.time_entries
  for each row
  execute function public.trg_time_entries_notify_ppe_missing();

notify pgrst, 'reload schema';
