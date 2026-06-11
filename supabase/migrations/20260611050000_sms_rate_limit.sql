-- SMS cost-DoS guard.
--
-- twilio-send-sms (admin-gated) and twilio-send-message (participant-gated)
-- had no per-actor/per-org spend cap, so a single authenticated admin — or a
-- compromised admin session / malicious-but-authorized participant — could
-- loop the endpoint and run up an unbounded paid-SMS bill on the org's Twilio
-- account. This adds an atomic hourly segment quota the edge functions claim
-- before each send.
--
-- Per-actor hourly cap (segments). Conservative default that's far above
-- normal dispatch volume but stops a runaway loop. Tune via the v_cap literal.

create table if not exists public.sms_quota (
  actor_id    text not null,
  window_hour timestamptz not null,
  segments    int not null default 0,
  primary key (actor_id, window_hour)
);

-- RLS on, no policies → anon/authenticated denied; service_role (the only
-- caller, via the edge functions) bypasses RLS.
alter table public.sms_quota enable row level security;

-- Atomic claim. Increments the actor's current-hour counter iff it stays under
-- the cap; the FOR UPDATE row lock serializes concurrent claims so two parallel
-- sends can't both slip past the limit. Returns whether the send is allowed.
create or replace function public.claim_sms_quota(p_actor text, p_segments int default 1)
returns table (allowed boolean, used int, cap int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hour  timestamptz := date_trunc('hour', now());
  v_cap   int := 300;
  v_actor text := coalesce(nullif(p_actor, ''), 'unknown');
  v_seg   int := greatest(coalesce(p_segments, 1), 1);
  v_used  int;
begin
  insert into public.sms_quota (actor_id, window_hour, segments)
  values (v_actor, v_hour, 0)
  on conflict (actor_id, window_hour) do nothing;

  select segments into v_used
    from public.sms_quota
   where actor_id = v_actor and window_hour = v_hour
   for update;

  if v_used + v_seg > v_cap then
    allowed := false; used := v_used; cap := v_cap;
    return next; return;
  end if;

  update public.sms_quota
     set segments = segments + v_seg
   where actor_id = v_actor and window_hour = v_hour;

  allowed := true; used := v_used + v_seg; cap := v_cap;
  return next;
end $$;

revoke all on function public.claim_sms_quota(text, int) from public, anon, authenticated;
grant execute on function public.claim_sms_quota(text, int) to service_role;

-- Periodic cleanup of old windows so the table stays small. Best-effort; if
-- pg_cron isn't available the table just grows slowly (one row per actor/hour).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'sms-quota-prune',
      '17 4 * * *',
      $cron$delete from public.sms_quota where window_hour < now() - interval '7 days'$cron$
    );
  end if;
exception when others then
  null; -- never fail the migration on cron wiring
end $$;
