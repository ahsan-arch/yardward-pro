-- /t/<token> landing page always showed "Hi Driver" with a "?" avatar instead
-- of the driver's real name — validate_driver_token only ever returned
-- driver_id, so the frontend fell back to driverById() from the mock demo
-- dataset, which never matches a real Supabase driver UUID. Add driver_name
-- so the anon-callable RPC can answer the one thing the landing page
-- actually needs from profiles without a separate authenticated read.

create or replace function public.validate_driver_token(p_token text)
returns table (
  driver_id    uuid,
  driver_name  text,
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
    driver_id := null; driver_name := null; scoped_to := null; expires_at := null; used_at := null; state := 'unknown';
    return next;
    return;
  end if;

  select * into v_row from public.driver_tokens where token = p_token;
  if not found then
    driver_id := null; driver_name := null; scoped_to := null; expires_at := null; used_at := null; state := 'unknown';
    return next;
    return;
  end if;

  driver_id  := v_row.driver_id;
  select p.name into driver_name from public.profiles p where p.id = v_row.driver_id;
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
  'Anon-callable validator for tokenized driver links. Bypasses driver_tokens RLS via SECURITY DEFINER. Returns one row with state=valid|expired|used|unknown and the driver''s display name.';
