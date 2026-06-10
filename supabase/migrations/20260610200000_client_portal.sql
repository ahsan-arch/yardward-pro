-- =============================================================================
-- Client dump-form portal (Phase 1 of the Formstack replacement).
--
--   - client_portal_tokens: revocable per-employee access codes. A client
--     company gets N codes (one per driver/dispatcher). When an employee
--     leaves, the admin revokes THAT code — no link redistribution. Codes
--     are stored plaintext deliberately: the admin must be able to read a
--     code back to a client over the phone, and the blast radius of a code
--     is "can submit a dump form for that one client".
--   - clients.portal_driver_names / portal_truck_numbers: per-client
--     dropdown lists shown on the portal form (mirrors how the Formstack
--     forms were pre-populated per client).
--   - dump_logs grows portal columns: client_id, submission_code (unique,
--     human-quotable), source, submitted_name/truck_number (portal users
--     are NOT auth users, so driver_id becomes nullable), and the
--     approval-flow columns (status/approved_by/approved_at) used by the
--     Phase 2 yard sign-off.
--
-- Portal access path: the client-portal edge function validates the code
-- and writes with service_role. RLS on these tables is admin-only — the
-- anon/public role can read nothing directly.
-- =============================================================================

create table if not exists public.client_portal_tokens (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references public.clients (id) on delete cascade,
  code         text not null unique,
  label        text not null default '',
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz,
  use_count    integer not null default 0
);

create index if not exists client_portal_tokens_client_idx
  on public.client_portal_tokens (client_id, created_at desc);

alter table public.client_portal_tokens enable row level security;

create policy client_portal_tokens_admin_all on public.client_portal_tokens
  for all using (is_admin()) with check (is_admin());

-- Per-client dropdown lists for the portal form.
alter table public.clients
  add column if not exists portal_driver_names text[] not null default '{}',
  add column if not exists portal_truck_numbers text[] not null default '{}';

-- Portal columns on dump_logs. Portal submitters are not auth users, so the
-- record carries their name + truck as text and driver_id becomes nullable
-- (still required by RLS for driver-app inserts; portal inserts go through
-- the service-role edge function).
alter table public.dump_logs
  alter column driver_id drop not null;

alter table public.dump_logs
  add column if not exists client_id text references public.clients (id) on delete set null,
  add column if not exists submission_code text,
  add column if not exists source text not null default 'driver-app',
  add column if not exists portal_token_id uuid references public.client_portal_tokens (id) on delete set null,
  add column if not exists submitted_name text not null default '',
  add column if not exists truck_number text not null default '',
  add column if not exists status text not null default 'submitted',
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

create unique index if not exists dump_logs_submission_code_idx
  on public.dump_logs (submission_code) where submission_code is not null;
create index if not exists dump_logs_client_idx
  on public.dump_logs (client_id, logged_at desc);
create index if not exists dump_logs_status_idx
  on public.dump_logs (status) where status = 'submitted';
