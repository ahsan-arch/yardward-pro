-- =============================================================================
-- Sprint 2: Realtime publication, server-side token gating, dead-letter queue
-- =============================================================================
-- This migration:
--   1. Adds key tables to the supabase_realtime publication so the web client
--      can subscribe to postgres_changes for live UI updates.
--   2. Introduces a SECURITY DEFINER RPC (consume_driver_token) so the act of
--      "burning" a single-use driver link cannot be skipped by a malicious
--      client. The RPC atomically claims the token and is safe against replay
--      across devices.
--   3. Creates a dead_letter_submissions table for offline-queue items that
--      have exhausted retries, so an admin can inspect / requeue them.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Realtime publication
-- -----------------------------------------------------------------------------
-- alter publication ... add table is not idempotent on its own; wrap each call
-- so re-running the migration on an environment where it has already been
-- applied (or where the table was added manually via the dashboard) does not
-- error.

do $$
begin
  alter publication supabase_realtime add table public.jobs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.work_orders;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.ticket_photos;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.time_entries;
exception
  when duplicate_object then null;
  when undefined_object then null;
end
$$;


-- -----------------------------------------------------------------------------
-- 2. Server-side driver-token gating
-- -----------------------------------------------------------------------------
-- Previously the API marked tokens used from client code, which is spoofable
-- (a malicious driver could intercept the request and replay the URL on
-- another device). This RPC is SECURITY DEFINER and performs the lookup +
-- atomic update in one trip, returning true only if THIS call is the one
-- that flipped used_at from NULL to now(). Concurrent calls lose the race
-- and receive false.

create or replace function public.consume_driver_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row driver_tokens%rowtype;
  v_updated integer;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return false;
  end if;

  select *
    into v_row
    from public.driver_tokens
   where token = p_token
   limit 1;

  -- Not found, expired, or already consumed -> reject.
  if not found then
    return false;
  end if;

  if v_row.expires_at < now() then
    return false;
  end if;

  if v_row.used_at is not null then
    return false;
  end if;

  -- Atomic claim: the WHERE used_at IS NULL clause means at most one
  -- caller wins this update across concurrent invocations.
  update public.driver_tokens
     set used_at = now()
   where token = p_token
     and used_at is null;

  get diagnostics v_updated = row_count;

  return v_updated = 1;
end;
$$;

revoke all on function public.consume_driver_token(text) from public;
grant execute on function public.consume_driver_token(text) to anon, authenticated;

comment on function public.consume_driver_token(text) is
  'Atomically claims a driver_tokens row for single use. Returns true if this '
  'call successfully marked the token used; false if the token is missing, '
  'expired, already used, or lost a race with a concurrent caller. '
  'SECURITY DEFINER so anon clients cannot bypass the update via RLS.';


-- -----------------------------------------------------------------------------
-- 3. Dead-letter queue for offline / retried submissions
-- -----------------------------------------------------------------------------
-- When the offline submission queue exhausts its retry budget for a payload
-- (work order, start-of-day, ticket photo, etc.) the server-side mover should
-- park the row here so a human can inspect, fix, and replay it. Keeping it in
-- the database (rather than logs) gives us RLS-scoped visibility and survives
-- log rotation.

create table if not exists public.dead_letter_submissions (
  id                        uuid primary key default gen_random_uuid(),
  kind                      text not null,
  payload                   jsonb not null,
  last_error                text,
  retry_count               integer not null default 0,
  queued_at                 timestamptz not null,
  last_attempt_at           timestamptz,
  user_id                   uuid references public.profiles (id) on delete set null,
  moved_to_dead_letter_at   timestamptz not null default now()
);

create index if not exists dead_letter_submissions_moved_at_idx
  on public.dead_letter_submissions (moved_to_dead_letter_at desc);

create index if not exists dead_letter_submissions_kind_idx
  on public.dead_letter_submissions (kind);

create index if not exists dead_letter_submissions_user_idx
  on public.dead_letter_submissions (user_id);

alter table public.dead_letter_submissions enable row level security;

-- Admins see and manage everything.
drop policy if exists dead_letter_submissions_admin_all on public.dead_letter_submissions;
create policy dead_letter_submissions_admin_all
  on public.dead_letter_submissions
  for all
  using (is_admin())
  with check (is_admin());

-- Users can see their own dead-lettered submissions (useful for showing
-- "your offline ticket failed to sync -- contact dispatch" in the UI).
drop policy if exists dead_letter_submissions_user_select_own on public.dead_letter_submissions;
create policy dead_letter_submissions_user_select_own
  on public.dead_letter_submissions
  for select
  using (user_id = auth.uid());

-- The dead-letter mover runs server-side under the service_role key, which
-- already bypasses RLS, but we add an explicit INSERT policy for clarity and
-- so the table can be written from a SECURITY INVOKER edge function if we
-- ever choose that path. service_role is implicit; this policy just makes
-- the intent grep-able.
drop policy if exists dead_letter_submissions_service_insert on public.dead_letter_submissions;
create policy dead_letter_submissions_service_insert
  on public.dead_letter_submissions
  for insert
  to service_role
  with check (true);

comment on table public.dead_letter_submissions is
  'Terminal storage for offline-queue submissions that exhausted their retry '
  'budget. Rows are written by server-side movers and inspected/requeued by '
  'admins.';
