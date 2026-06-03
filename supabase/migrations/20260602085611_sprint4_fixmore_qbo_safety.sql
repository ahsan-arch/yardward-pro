-- Sprint 4 fix-more pass: QBO safety hardening
--
-- 1) Make QBO payroll TimeActivity pushes idempotent at the DB layer.
-- 2) Persist QBO access-token cache so concurrent edge functions can reuse it.
-- 3) Add SECURITY DEFINER advisory-lock helpers to serialize QBO OAuth refresh
--    across concurrent edge function invocations.

-- -----------------------------------------------------------------------------
-- 1. Unique partial index: idempotent payroll TimeActivity inserts
-- -----------------------------------------------------------------------------
-- Two admins firing payroll for the same window concurrently will both try to
-- INSERT 'pushed' rows for the same time_entry_id. This unique partial index
-- forces the second insert to fail with 23505, which the function catches and
-- converts to 'skipped' with error 'already pushed' — preventing duplicate QBO
-- TimeActivity insertions.
create unique index if not exists qbo_payroll_pushes_pushed_once
  on public.qbo_payroll_pushes (time_entry_id)
  where status = 'pushed';

-- -----------------------------------------------------------------------------
-- 2. Access-token cache columns on qbo_oauth_tokens
-- -----------------------------------------------------------------------------
-- Lets concurrent QBO edge functions reuse a live access_token instead of each
-- calling Intuit /oauth2/v1/tokens. qbo-push-invoice already returns
-- access_token transiently; persisting it lets a second function reuse it.
alter table public.qbo_oauth_tokens
  add column if not exists access_token text,
  add column if not exists access_token_expires_at timestamptz;

-- -----------------------------------------------------------------------------
-- 3. Advisory-lock helpers for QBO OAuth refresh serialization
-- -----------------------------------------------------------------------------
-- Edge functions hold a single PostgREST session per invocation.
-- pg_advisory_lock blocks until the lock is free; pg_advisory_unlock releases
-- it. Both qbo-push-time and qbo-push-invoice will call lock at refresh start
-- and unlock when persist completes (or in a finally), serializing the
-- refresh-token rotation.

create or replace function public.lock_qbo_oauth_refresh()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_lock(hashtext('qbo_oauth_default'));
end $$;
revoke all on function public.lock_qbo_oauth_refresh() from public, anon, authenticated;
grant execute on function public.lock_qbo_oauth_refresh() to service_role;

create or replace function public.unlock_qbo_oauth_refresh()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_unlock(hashtext('qbo_oauth_default'));
end $$;
revoke all on function public.unlock_qbo_oauth_refresh() from public, anon, authenticated;
grant execute on function public.unlock_qbo_oauth_refresh() to service_role;
