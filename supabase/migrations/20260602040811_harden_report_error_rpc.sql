-- Tighten report_error against runaway clients and oversized payloads.
-- 1. LEFT-truncate all text inputs to sensible bounds (in addition to the
--    existing p_message/p_stack truncation).
-- 2. Cap p_context jsonb size; replace with a marker object if too large.
-- 3. Per-(user_id or session_id) rate limit: drop inserts when the same
--    caller has logged > 60 errors in the last minute.

create or replace function public.report_error(
  p_source text,
  p_error_code text,
  p_message text,
  p_severity text default 'error',
  p_stack text default null,
  p_url text default null,
  p_user_agent text default null,
  p_function_name text default null,
  p_context jsonb default '{}'::jsonb,
  p_session_id text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_user_id uuid := auth.uid();
  v_context jsonb := coalesce(p_context, '{}'::jsonb);
  v_caller_key text := coalesce(v_user_id::text, p_session_id, 'anonymous');
  v_recent_count integer;
begin
  -- Rate limit: 60 reports / minute per caller
  select count(*) into v_recent_count
  from public.error_log
  where coalesce(user_id::text, session_id, 'anonymous') = v_caller_key
    and created_at > now() - interval '1 minute';

  if v_recent_count >= 60 then
    return null;
  end if;

  -- Cap context payload (16 KB raw text)
  if length(v_context::text) > 16384 then
    v_context := jsonb_build_object(
      '_truncated', true,
      'original_size_bytes', length(v_context::text)
    );
  end if;

  insert into public.error_log (
    source,
    severity,
    error_code,
    message,
    stack,
    user_id,
    session_id,
    url,
    user_agent,
    function_name,
    context
  ) values (
    p_source,
    coalesce(p_severity, 'error'),
    left(coalesce(p_error_code, ''), 100),
    left(coalesce(p_message, ''), 2000),
    left(p_stack, 8000),
    v_user_id,
    left(p_session_id, 100),
    left(p_url, 2000),
    left(p_user_agent, 1000),
    left(p_function_name, 200),
    v_context
  )
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.report_error(
  text, text, text, text, text, text, text, text, jsonb, text
) to anon, authenticated, service_role;

-- Belt-and-suspenders: a CHECK constraint at the table level on error_code.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.error_log'::regclass
      and conname  = 'error_log_error_code_len'
  ) then
    alter table public.error_log
      add constraint error_log_error_code_len check (length(error_code) <= 100);
  end if;
end $$;
