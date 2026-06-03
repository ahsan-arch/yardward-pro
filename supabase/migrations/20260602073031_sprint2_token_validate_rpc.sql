-- Sprint 2 fix-more: the headline token landing page (/t/<token>) calls
-- api.validateDriverToken which did a plain SELECT against public.driver_tokens.
-- That table has RLS enabled with admin OR driver_id=auth.uid() policies. Anon
-- visitors hitting a deep link have no session, so every token validation
-- returned null and the page rendered "Link invalid" for everyone.
--
-- Fix: SECURITY DEFINER RPC that anon can call, returning the minimal fields
-- the landing page needs to distinguish valid / expired / used / unknown.

create or replace function public.validate_driver_token(p_token text)
returns table (
  driver_id    uuid,
  scoped_to    public.token_scope,
  expires_at   timestamptz,
  used_at      timestamptz,
  state        text  -- 'valid' | 'expired' | 'used' | 'unknown'
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.driver_tokens%rowtype;
begin
  if p_token is null or length(p_token) = 0 then
    driver_id := null; scoped_to := null; expires_at := null; used_at := null; state := 'unknown';
    return next;
    return;
  end if;

  select * into v_row from public.driver_tokens where token = p_token;
  if not found then
    driver_id := null; scoped_to := null; expires_at := null; used_at := null; state := 'unknown';
    return next;
    return;
  end if;

  driver_id  := v_row.driver_id;
  scoped_to  := v_row.scoped_to;
  expires_at := v_row.expires_at;
  used_at    := v_row.used_at;
  if v_row.used_at is not null then
    state := 'used';
  elsif v_row.expires_at < now() then
    state := 'expired';
  else
    state := 'valid';
  end if;
  return next;
end;
$$;

revoke all on function public.validate_driver_token(text) from public;
grant execute on function public.validate_driver_token(text) to anon, authenticated;

comment on function public.validate_driver_token(text) is
  'Anon-callable validator for tokenized driver links. Bypasses driver_tokens RLS via SECURITY DEFINER. Returns one row with state=valid|expired|used|unknown.';

-- Also: the original sprint2 migration missed vehicles in the realtime
-- publication. The trg_vehicles_set_last_pretrip trigger updates
-- vehicles.last_pretrip_at after every passing inspection; without the
-- publication entry that update never broadcasts to admin clients and the
-- pre-trip lockout banner stays stale until manual reload.
do $$
begin
  alter publication supabase_realtime add table public.vehicles;
exception when duplicate_object then null;
when undefined_object then null;
end $$;
