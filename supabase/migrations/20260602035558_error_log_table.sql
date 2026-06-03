-- ============================================================================
-- Migration: error_log table + report_error RPC + unresolved_errors view
-- ============================================================================
-- Centralized error logging for the CRM. Clients (frontend, edge functions,
-- driver app, integrations, database triggers) report errors via the
-- report_error RPC, which is the ONLY supported write path.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: public.error_log
-- ----------------------------------------------------------------------------
create table if not exists public.error_log (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  source            text not null check (source in ('frontend', 'edge_function', 'database', 'integration', 'driver_app')),
  severity          text not null check (severity in ('info', 'warn', 'error', 'critical')) default 'error',
  error_code        text not null,
  message           text not null,
  stack             text,
  user_id           uuid references public.profiles(id) on delete set null,
  session_id        text,
  url               text,
  user_agent        text,
  function_name     text,
  context           jsonb not null default '{}'::jsonb,
  resolved_at       timestamptz,
  resolved_by       uuid references public.profiles(id),
  resolution_notes  text
);

comment on table  public.error_log               is 'Centralized error log. Writes only via public.report_error RPC.';
comment on column public.error_log.source        is 'Where the error originated: frontend, edge_function, database, integration, driver_app.';
comment on column public.error_log.severity      is 'Severity: info, warn, error, critical.';
comment on column public.error_log.error_code    is 'HTTP status code as string OR app-defined code (e.g. NETWORK_TIMEOUT, AUTH_FAILED, VALIDATION).';
comment on column public.error_log.session_id    is 'Browser session id for anonymous (unauthenticated) errors.';
comment on column public.error_log.url           is 'Route (frontend) or function name / endpoint (server).';
comment on column public.error_log.function_name is 'Edge function name when source = edge_function.';
comment on column public.error_log.context       is 'Arbitrary structured context (request payload, breadcrumbs, etc.).';

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
create index if not exists error_log_resolved_at_created_at_idx
  on public.error_log (resolved_at, created_at desc);

create index if not exists error_log_user_id_created_at_idx
  on public.error_log (user_id, created_at desc);

create index if not exists error_log_source_severity_created_at_idx
  on public.error_log (source, severity, created_at desc);

create index if not exists error_log_error_code_idx
  on public.error_log (error_code);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.error_log enable row level security;

-- Admins: full read
drop policy if exists "error_log admin select" on public.error_log;
create policy "error_log admin select"
  on public.error_log
  for select
  to authenticated
  using (public.is_admin());

-- Admins: full update (triage / resolution)
drop policy if exists "error_log admin update" on public.error_log;
create policy "error_log admin update"
  on public.error_log
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Admins: full delete
drop policy if exists "error_log admin delete" on public.error_log;
create policy "error_log admin delete"
  on public.error_log
  for delete
  to authenticated
  using (public.is_admin());

-- Authenticated users: can read their own errors
drop policy if exists "error_log own select" on public.error_log;
create policy "error_log own select"
  on public.error_log
  for select
  to authenticated
  using (user_id = auth.uid());

-- NOTE: intentionally NO INSERT policy. All writes must go through
-- public.report_error (security definer).

-- ----------------------------------------------------------------------------
-- RPC: public.report_error
-- ----------------------------------------------------------------------------
create or replace function public.report_error(
  p_source        text,
  p_error_code    text,
  p_message       text,
  p_severity      text       default 'error',
  p_stack         text       default null,
  p_url           text       default null,
  p_user_agent    text       default null,
  p_function_name text       default null,
  p_context       jsonb      default '{}'::jsonb,
  p_session_id    text       default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_user    uuid := auth.uid();
  v_stack   text := left(coalesce(p_stack, ''), 8000);
  v_message text := left(coalesce(p_message, ''), 2000);
begin
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
    p_error_code,
    v_message,
    nullif(v_stack, ''),
    v_user,
    p_session_id,
    p_url,
    p_user_agent,
    p_function_name,
    coalesce(p_context, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.report_error(text, text, text, text, text, text, text, text, jsonb, text)
  is 'Reports an error into public.error_log. Auto-fills user_id from auth.uid(). Truncates message to 2000 chars and stack to 8000 chars. Only supported insert path.';

-- Lock down default privileges, then grant explicitly.
revoke all on function public.report_error(text, text, text, text, text, text, text, text, jsonb, text) from public;

grant execute on function public.report_error(text, text, text, text, text, text, text, text, jsonb, text)
  to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- View: public.unresolved_errors
-- ----------------------------------------------------------------------------
create or replace view public.unresolved_errors as
select *
from public.error_log
where resolved_at is null
order by
  case severity
    when 'critical' then 4
    when 'error'    then 3
    when 'warn'     then 2
    when 'info'     then 1
    else 0
  end desc,
  created_at desc;

comment on view public.unresolved_errors is 'All unresolved error_log rows, ordered by severity (critical first) then most recent.';
