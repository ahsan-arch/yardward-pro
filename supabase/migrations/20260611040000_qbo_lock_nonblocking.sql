-- QBO refresh lock: make it non-blocking + self-healing.
--
-- The original lock_qbo_oauth_refresh() used a blocking pg_advisory_lock
-- (session-level). That lock is owned by the specific pooled backend that ran
-- it, but the edge function releases it in a SEPARATE PostgREST request
-- (unlock_qbo_oauth_refresh) that can land on a DIFFERENT pooled backend — so
-- the original lock is never released and stays held on its backend. Once that
-- happens, every later blocking pg_advisory_lock() waits behind the leaked
-- lock, eventually stalling ALL QBO refreshes until the connection is recycled.
--
-- Fix: bounded NON-blocking acquire. Try pg_try_advisory_lock for ~10s; if we
-- still can't get it, return WITHOUT the lock. This is safe because the edge
-- function now persists the rotated refresh_token with an optimistic
-- compare-and-swap (see _shared/qbo-oauth.ts) — rotation stays correct even
-- when two refreshes run unserialized, and Intuit's refresh-token grace window
-- tolerates the brief overlap. Giving up beats a permanent stall.

create or replace function public.lock_qbo_oauth_refresh()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_attempts int := 0;
begin
  while not pg_try_advisory_lock(hashtext('qbo_oauth_default')) loop
    v_attempts := v_attempts + 1;
    exit when v_attempts >= 100;  -- ~10s of 100ms polls, then proceed unlocked
    perform pg_sleep(0.1);
  end loop;
end $$;

revoke all on function public.lock_qbo_oauth_refresh() from public, anon, authenticated;
grant execute on function public.lock_qbo_oauth_refresh() to service_role;
