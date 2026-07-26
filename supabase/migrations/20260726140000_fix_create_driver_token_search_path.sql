-- =============================================================================
-- create_driver_token has been broken since it was introduced (migration
-- 20260602121520) — every single call to Admin Settings -> Driver tokens ->
-- Generate token fails with "function gen_random_bytes(integer) does not
-- exist". Found via QA (2026-07-26).
--
-- Root cause: the function is SECURITY DEFINER with
-- `set search_path = public, pg_temp`. Supabase installs the pgcrypto
-- extension (which provides gen_random_bytes) into the `extensions` schema,
-- not `public` — a SECDEF function's locked search_path never resolves it
-- there. This exact gotcha was already hit and worked around once in this
-- codebase (see the comment on public._comms_gen_id in
-- 20260605131840_communications_core.sql), but that fix avoided
-- gen_random_bytes entirely rather than fixing the search_path, and nobody
-- went back to fix this earlier, still-broken function.
--
-- Unlike _comms_gen_id (an internal id, fine to weaken to md5(random())),
-- this token is a bearer-style credential — anyone holding it gets
-- driver-app access with no login (/t/<token>). It needs to stay a real
-- CSPRNG, so the fix is to add `extensions` to the search_path rather than
-- swap to a weaker generator.
--
-- This means NO admin has ever successfully generated a working tokenized
-- driver link in production. Re-created identically to the original
-- function body, only the search_path changed.
-- =============================================================================

create or replace function public.create_driver_token(
  p_driver_id uuid,
  p_scope     text,
  p_hours     integer default 12
)
returns table (id text, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id      text;
  v_token   text;
  v_expires timestamptz;
  v_scope   token_scope;
begin
  if not public.is_admin() then
    raise exception 'create_driver_token requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_scope not in ('forms', 'job', 'shift') then
    raise exception 'invalid scope %', p_scope;
  end if;
  v_scope := p_scope::token_scope;

  if p_hours is null or p_hours <= 0 then
    raise exception 'p_hours must be positive';
  end if;

  -- CSPRNG: gen_random_bytes from pgcrypto, base64url-encoded so the token
  -- is URL-safe for the /t/<token> landing page.
  v_token := encode(gen_random_bytes(32), 'base64');
  v_token := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  v_id := 'TKN-' || substr(md5(v_token), 1, 10);
  v_expires := now() + (p_hours || ' hours')::interval;

  insert into public.driver_tokens (id, driver_id, token, scoped_to, expires_at, used_at, created_at)
  values (v_id, p_driver_id, v_token, v_scope, v_expires, null, now());

  id := v_id;
  token := v_token;
  expires_at := v_expires;
  return next;
end $$;

revoke all on function public.create_driver_token(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_driver_token(uuid, text, integer)
  to authenticated, service_role;
