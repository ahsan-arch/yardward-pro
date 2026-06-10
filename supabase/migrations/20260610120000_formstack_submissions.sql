-- Formstack hauling-record import target.
--
-- One row per Formstack submission, pulled by the formstack-import edge
-- function from the v2025 API. Forms vary per client (EHS Dump Form, Brass
-- Inc. Hauling Record, ...) so the field payload is stored as the
-- standardized jsonb array Formstack returns ({field,label,type,
-- displayValue,parsedValue}) rather than as fixed columns; `summary` holds
-- a short human-readable digest for list views so the admin table doesn't
-- need to unpack jsonb client-side.
--
-- id is 'FS-<submission_id>' to match the FLEETIO-<id> convention used by
-- fleetio-import; submission_id keeps the raw numeric key for joins back
-- to Formstack and for the incremental-sync high-water mark.

create table if not exists public.formstack_submissions (
  id text primary key,
  submission_id bigint not null unique,
  form_id bigint not null,
  form_name text not null default '',
  submitted_at timestamptz,
  summary text not null default '',
  data jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now()
);

create index if not exists formstack_submissions_form_idx
  on public.formstack_submissions (form_id, submitted_at desc);
create index if not exists formstack_submissions_submitted_idx
  on public.formstack_submissions (submitted_at desc);

alter table public.formstack_submissions enable row level security;

-- Admin-only in the SPA; the import edge function writes with service_role
-- which bypasses RLS.
drop policy if exists formstack_submissions_admin_all on public.formstack_submissions;
create policy formstack_submissions_admin_all on public.formstack_submissions
  for all using (is_admin()) with check (is_admin());

-- Per-form facets for the /admin/hauling-records filter dropdown.
-- security_invoker so the underlying table's RLS still applies to SPA reads.
create or replace view public.formstack_form_facets
  with (security_invoker = true) as
  select
    form_id,
    form_name,
    count(*)::int as submission_count,
    max(submitted_at) as latest_submitted_at
  from public.formstack_submissions
  group by form_id, form_name;
