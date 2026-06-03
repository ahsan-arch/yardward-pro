-- Migration: qbo_oauth_tokens and integration_alerts
-- Creates a singleton table for QBO refresh token rotation and an alerts table
-- for surfacing integration failures to admins.

-- ============================================================================
-- 1. qbo_oauth_tokens: singleton table for rotated QBO refresh tokens
-- ============================================================================

-- Singleton enforced via fixed text primary key. The function expects id='default'.
create table if not exists public.qbo_oauth_tokens (
  id text primary key default 'default' check (id = 'default'),
  refresh_token text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.qbo_oauth_tokens is
  'Stores the rotating QuickBooks Online OAuth refresh token. Only one row ever (id is always ''default'').';

comment on column public.qbo_oauth_tokens.refresh_token is
  'The current QBO refresh token. Rotated on each token refresh.';

-- Keep updated_at fresh on row updates
create or replace function public.qbo_oauth_tokens_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists qbo_oauth_tokens_set_updated_at on public.qbo_oauth_tokens;
create trigger qbo_oauth_tokens_set_updated_at
  before update on public.qbo_oauth_tokens
  for each row
  execute function public.qbo_oauth_tokens_set_updated_at();

-- Enable RLS
alter table public.qbo_oauth_tokens enable row level security;

-- Admin-only policies (service_role bypasses RLS automatically)
drop policy if exists "qbo_oauth_tokens_admin_select" on public.qbo_oauth_tokens;
create policy "qbo_oauth_tokens_admin_select"
  on public.qbo_oauth_tokens
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists "qbo_oauth_tokens_admin_insert" on public.qbo_oauth_tokens;
create policy "qbo_oauth_tokens_admin_insert"
  on public.qbo_oauth_tokens
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "qbo_oauth_tokens_admin_update" on public.qbo_oauth_tokens;
create policy "qbo_oauth_tokens_admin_update"
  on public.qbo_oauth_tokens
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "qbo_oauth_tokens_admin_delete" on public.qbo_oauth_tokens;
create policy "qbo_oauth_tokens_admin_delete"
  on public.qbo_oauth_tokens
  for delete
  to authenticated
  using (public.is_admin());


-- ============================================================================
-- 2. integration_alerts: log of integration failures needing admin attention
-- ============================================================================

create table if not exists public.integration_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.integration_alerts is
  'Log of integration failures (QBO, Geotab, etc.) surfaced to admins for triage.';

comment on column public.integration_alerts.kind is
  'Short machine-readable alert kind, e.g. ''qbo_refresh_persist_failed'', ''geotab_auth_failed''.';

comment on column public.integration_alerts.context is
  'Arbitrary structured context (request ids, error codes, etc.) for debugging.';

comment on column public.integration_alerts.resolved_at is
  'Timestamp when an admin marked this alert resolved. NULL means open.';

-- Index optimized for unresolved-alerts queries:
--   select ... from integration_alerts where resolved_at is null order by created_at desc
create index if not exists integration_alerts_resolved_created_idx
  on public.integration_alerts (resolved_at, created_at desc);

-- Enable RLS
alter table public.integration_alerts enable row level security;

-- Admins can read alerts
drop policy if exists "integration_alerts_admin_select" on public.integration_alerts;
create policy "integration_alerts_admin_select"
  on public.integration_alerts
  for select
  to authenticated
  using (public.is_admin());

-- Admins can update alerts (e.g. mark as resolved)
drop policy if exists "integration_alerts_admin_update" on public.integration_alerts;
create policy "integration_alerts_admin_update"
  on public.integration_alerts
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- service_role can insert alerts (from edge functions / background jobs).
-- service_role bypasses RLS, but we add an explicit policy for clarity and in
-- case the role is ever downgraded.
drop policy if exists "integration_alerts_service_role_insert" on public.integration_alerts;
create policy "integration_alerts_service_role_insert"
  on public.integration_alerts
  for insert
  to service_role
  with check (true);
