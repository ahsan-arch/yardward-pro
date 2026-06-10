-- =============================================================================
-- dump_logs: native hauling records (dump / load forms) captured in the
-- driver app. Replaces Formstack for NEW submissions — historical Formstack
-- data stays in formstack_submissions (imported by formstack-import); the
-- /admin/hauling-records page shows both sources.
--
-- Deliberately a standalone record (no approval flow, no signature): the
-- billing-side dump/load capture with foreman sign-off remains the
-- work_orders flow. This table is the regulatory/BOL-style hauling log the
-- per-client Formstack forms covered (loading site, load type + quantity,
-- weight manual entry, receiving site), stamped with GPS + timestamps.
-- =============================================================================

create table if not exists public.dump_logs (
  id              text primary key,
  driver_id       uuid not null references public.drivers (id) on delete cascade,
  job_id          text references public.jobs (id) on delete set null,
  vehicle_id      text references public.vehicles (id),
  load_type       text not null,
  quantity        text not null default '',
  weight          text not null default '',
  location        text not null,
  receiving_site  text not null default '',
  notes           text not null default '',
  gps_lat         double precision,
  gps_lng         double precision,
  logged_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  idempotency_key text
);

-- Offline-queue replays insert with the same idempotency_key; the partial
-- unique index turns a duplicate flush into a structured 23505 the api layer
-- resolves to the existing row (same pattern as work_orders / job_logs).
create unique index if not exists dump_logs_idempotency_idx
  on public.dump_logs (idempotency_key) where idempotency_key is not null;

create index if not exists dump_logs_driver_logged_idx
  on public.dump_logs (driver_id, logged_at desc);
create index if not exists dump_logs_logged_idx
  on public.dump_logs (logged_at desc);

alter table public.dump_logs enable row level security;

create policy dump_logs_admin_all on public.dump_logs
  for all using (is_admin()) with check (is_admin());

create policy dump_logs_driver_read_own on public.dump_logs
  for select using (driver_id = auth.uid());

create policy dump_logs_driver_insert_own on public.dump_logs
  for insert with check (driver_id = auth.uid());
