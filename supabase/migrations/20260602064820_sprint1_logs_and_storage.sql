-- =============================================================================
-- YardwardPro · Sprint 1
--   - job_logs: driver-side journal entries during a job (text + optional GPS)
--   - purchase_requests.inventory_check_result: snapshot of matched inventory
--     items captured at submission time
--   - Storage bucket "ticket-photos" (private) for dump-ticket photo uploads,
--     with admin / driver RLS policies on storage.objects
-- =============================================================================

-- -----------------------------------------------------------------------------
-- job_logs
-- -----------------------------------------------------------------------------
create table public.job_logs (
  id          text primary key,
  job_id      text not null references public.jobs (id) on delete cascade,
  driver_id   uuid not null references public.drivers (id) on delete cascade,
  vehicle_id  text references public.vehicles (id),
  body        text not null,
  gps_lat     double precision,
  gps_lng     double precision,
  logged_at   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index job_logs_job_logged_at_idx
  on public.job_logs (job_id, logged_at desc);
create index job_logs_driver_logged_at_idx
  on public.job_logs (driver_id, logged_at desc);

alter table public.job_logs enable row level security;

create policy job_logs_admin_all on public.job_logs
  for all using (is_admin()) with check (is_admin());

create policy job_logs_driver_read_own on public.job_logs
  for select using (driver_id = auth.uid());

create policy job_logs_driver_insert_own on public.job_logs
  for insert with check (driver_id = auth.uid());

-- -----------------------------------------------------------------------------
-- purchase_requests · inventory_check_result snapshot
-- -----------------------------------------------------------------------------
alter table public.purchase_requests
  add column if not exists inventory_check_result jsonb;

-- -----------------------------------------------------------------------------
-- Storage bucket: ticket-photos (private, 10 MB, image/jpeg|png|webp)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ticket-photos',
  'ticket-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Storage RLS policies on storage.objects scoped to bucket_id = 'ticket-photos'
create policy "ticket_photos_admin_all" on storage.objects
  for all
  using (bucket_id = 'ticket-photos' and is_admin())
  with check (bucket_id = 'ticket-photos' and is_admin());

create policy "ticket_photos_driver_insert" on storage.objects
  for insert
  with check (
    bucket_id = 'ticket-photos'
    and auth.role() = 'authenticated'
    and owner = auth.uid()
  );

create policy "ticket_photos_driver_select_own" on storage.objects
  for select
  using (
    bucket_id = 'ticket-photos'
    and owner = auth.uid()
  );
