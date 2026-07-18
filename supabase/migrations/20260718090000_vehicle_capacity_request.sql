-- =============================================================================
-- Request more vehicle capacity — self-service, never a hard block.
--
-- Client feedback (First Impressions #1 + Fleetio pressure point #5): "How
-- many vehicles can we enter into this system, it looks like 50 initially
-- we are currently at 30 which is not enough even for the hydrovac's and
-- service vehicle" / "Limitation of the number of vehicles we can enter
-- into the system at the current license level. Expensive to add more
-- vehicles."
--
-- billing_vehicles_limit was already tracked (see
-- 20260605094345_billing_status_and_user_notif_prefs.sql) but nothing ever
-- enforced it, and nothing let an admin ask for more — the client's actual
-- fear (a Fleetio-style hard paywall blocking fleet growth) was never
-- addressed either way. This adds a request flow that mirrors
-- request_cancel_subscription: it's a self-service "notify the team" ping,
-- not a technical cap. Deliberately does NOT add any check that blocks
-- creating a vehicle past the limit — the whole point is this system must
-- not repeat Fleetio's mistake.
-- =============================================================================

alter table public.app_settings
  add column if not exists billing_vehicle_capacity_requested_at timestamptz,
  add column if not exists billing_vehicle_capacity_request_note text;

create or replace function public.request_more_vehicle_capacity(
  p_requested_count integer,
  p_note text
) returns table (ok boolean, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'request_more_vehicle_capacity requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  update public.app_settings
     set billing_vehicle_capacity_requested_at = now(),
         billing_vehicle_capacity_request_note = nullif(trim(p_note), ''),
         updated_at = now()
   where id = 'default';

  insert into public.notifications (id, user_id, type, body, link, created_at)
  select
    'NT-' || substr(md5(p.id::text || clock_timestamp()::text), 1, 10),
    p.id,
    'system'::notification_type,
    format(
      'Additional vehicle capacity requested (%s vehicles)%s',
      p_requested_count,
      coalesce(' — ' || nullif(trim(p_note), ''), '')
    ),
    '/admin/settings?tab=billing',
    now()
  from public.profiles p
  where p.role = 'admin';

  ok := true; error := null; return next;
end;
$$;

revoke all on function public.request_more_vehicle_capacity(integer, text) from public, anon;
grant execute on function public.request_more_vehicle_capacity(integer, text) to authenticated, service_role;

notify pgrst, 'reload schema';
