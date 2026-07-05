-- Fix: a driver's failed offline submission can never reach admin review.
--
-- offline-queue.ts calls api.moveToDeadLetter when a queued submission exhausts
-- its retry budget. That ran a direct INSERT into dead_letter_submissions from
-- the DRIVER's browser — but the only INSERT policies on that table are
-- `admin_all` (is_admin()) and `service_insert` (service_role). A non-admin
-- driver's insert is therefore RLS-rejected, so the poison-pill submission is
-- stuck in localStorage forever and never surfaces at /admin/errors. The
-- "server-side mover" the table comment references was never built.
--
-- This SECURITY DEFINER RPC performs the insert on the authenticated caller's
-- behalf, attributing the row to auth.uid() so (a) the driver can still see it
-- via the existing user_select_own policy and (b) an admin can requeue it.
create or replace function public.move_to_dead_letter(
  p_kind            text,
  p_payload         jsonb,
  p_queued_at       timestamptz,
  p_retry_count     integer default 0,
  p_last_error      text default null,
  p_last_attempt_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'kind is required' using errcode = '22023';
  end if;
  insert into public.dead_letter_submissions
    (kind, payload, queued_at, retry_count, last_error, last_attempt_at, user_id)
  values
    (p_kind, coalesce(p_payload, '{}'::jsonb), p_queued_at, coalesce(p_retry_count, 0),
     p_last_error, p_last_attempt_at, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.move_to_dead_letter(text, jsonb, timestamptz, integer, text, timestamptz)
  from public, anon;
grant execute on function public.move_to_dead_letter(text, jsonb, timestamptz, integer, text, timestamptz)
  to authenticated, service_role;

comment on function public.move_to_dead_letter(text, jsonb, timestamptz, integer, text, timestamptz) is
  'Parks an exhausted offline-queue submission into dead_letter_submissions on '
  'the authenticated caller''s behalf (SECURITY DEFINER, attributed to auth.uid()). '
  'Replaces the RLS-rejected direct client insert so failed driver submissions '
  'reach admin review at /admin/errors.';
