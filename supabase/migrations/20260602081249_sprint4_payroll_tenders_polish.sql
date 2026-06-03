-- Sprint 4: QBO payroll mappings + push audit, tender sources/digests, weekly scrape cron.
-- All admin-gated. Cron uses the same vault.decrypted_secrets pattern as geotab-sync.

-- =============================================================================
-- 1. qbo_employee_mappings
--    One row per driver mapped into QBO's Employee list. PK on driver_id so a
--    driver can only map to one QBO employee (the QBO side is many-to-one fine).
-- =============================================================================
create table public.qbo_employee_mappings (
  driver_id        uuid primary key references public.drivers(id) on delete cascade,
  qbo_employee_id  text not null,
  mapped_by        uuid references public.profiles(id),
  mapped_at        timestamptz not null default now()
);

create index qbo_employee_mappings_qbo_employee_idx
  on public.qbo_employee_mappings (qbo_employee_id);

alter table public.qbo_employee_mappings enable row level security;

create policy qbo_employee_mappings_admin_all on public.qbo_employee_mappings
  for all using (is_admin()) with check (is_admin());

comment on table public.qbo_employee_mappings is
  'Driver -> QBO Employee link used by the payroll push job.';

-- =============================================================================
-- 2. qbo_payroll_pushes (audit trail)
--    One row per (driver, time_entry) we attempted to ship to QBO TimeActivity.
--    driver_id is set null on driver delete so the audit row survives — payroll
--    history must outlive a terminated driver. time_entry_id stays FK because
--    we want to be able to drill back into the source clock event when present.
-- =============================================================================
create table public.qbo_payroll_pushes (
  id                    uuid primary key default gen_random_uuid(),
  period_start          date not null,
  period_end            date not null,
  driver_id             uuid references public.drivers(id) on delete set null,
  time_entry_id         text references public.time_entries(id),
  hours                 numeric(10,2) not null,
  qbo_time_activity_id  text,
  status                text not null check (status in ('pending', 'pushed', 'failed', 'skipped')),
  error_message         text,
  created_at            timestamptz not null default now(),
  pushed_at             timestamptz
);

create index qbo_payroll_pushes_period_idx
  on public.qbo_payroll_pushes (period_start, period_end);
create index qbo_payroll_pushes_status_created_idx
  on public.qbo_payroll_pushes (status, created_at desc);
create index qbo_payroll_pushes_driver_period_idx
  on public.qbo_payroll_pushes (driver_id, period_start desc);

alter table public.qbo_payroll_pushes enable row level security;

create policy qbo_payroll_pushes_admin_all on public.qbo_payroll_pushes
  for all using (is_admin()) with check (is_admin());

comment on table public.qbo_payroll_pushes is
  'Audit log for QBO TimeActivity push attempts — one row per (driver, time_entry) try.';

-- =============================================================================
-- 3. tender_sources
--    The portals/feeds we scrape. id is the slug so edge functions can hardcode
--    'halton-region' without an extra lookup. enabled=false suspends scraping
--    without losing config.
-- =============================================================================
create table public.tender_sources (
  id           text primary key,
  name         text not null,
  base_url     text not null,
  enabled      boolean not null default true,
  last_run_at  timestamptz,
  last_error   text,
  notes        text,
  created_at   timestamptz not null default now()
);

alter table public.tender_sources enable row level security;

create policy tender_sources_admin_all on public.tender_sources
  for all using (is_admin()) with check (is_admin());

comment on table public.tender_sources is
  'Tender portals/feeds the scraper visits. id is a stable slug.';

-- Seed: production halton feed live, demo feed disabled so it never fires
-- accidentally but stays around as a reference row for new feeds.
insert into public.tender_sources (id, name, base_url, enabled) values
  ('halton-region', 'Halton Region Tenders', 'https://www.halton.ca/business/tenders', true),
  ('demo-feed',     'Demo Tender Feed',      'https://example.com/tenders.json',      false)
on conflict (id) do nothing;

-- =============================================================================
-- 4. tender_digests
--    Weekly snapshot of the scraped tenders. Unique on week_start_date so the
--    cron is idempotent — a re-run for the same Monday replaces the existing
--    digest (via ON CONFLICT in the edge function) instead of duplicating.
-- =============================================================================
create table public.tender_digests (
  id              uuid primary key default gen_random_uuid(),
  week_start_date date not null,
  week_end_date   date not null,
  tender_count    integer not null default 0,
  content         jsonb not null default '{}'::jsonb,
  generated_at    timestamptz not null default now(),
  sent_at         timestamptz,
  sent_to         text[]
);

create unique index tender_digests_week_start_unique
  on public.tender_digests (week_start_date);

alter table public.tender_digests enable row level security;

create policy tender_digests_admin_all on public.tender_digests
  for all using (is_admin()) with check (is_admin());

comment on table public.tender_digests is
  'Weekly snapshot of scraped tenders. content jsonb holds {tenders:[...], summary:"..."}.';

-- =============================================================================
-- 5. pg_cron: tender-scrape-weekly
--    Mondays 06:00 UTC. Same vault.decrypted_secrets('service_role_key')
--    pattern as the geotab cron. EXISTS-then-unschedule keeps the migration
--    idempotent across re-runs.
-- =============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  v_key text;
begin
  begin
    select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'service_role_key'
    limit 1;
  exception when others then
    v_key := null;
  end;

  if v_key is null then
    raise notice 'service_role_key not found in vault; tender-scrape cron will post with empty bearer until you store the secret via vault.create_secret.';
  end if;
end $$;

select cron.unschedule('tender-scrape-weekly')
where exists (select 1 from cron.job where jobname = 'tender-scrape-weekly');

select cron.schedule(
  'tender-scrape-weekly',
  '0 6 * * 1',
  $$
  select net.http_post(
    url     := 'https://pbyeatgjnrhvfnfiublj.supabase.co/functions/v1/tender-scrape',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
        ''
      )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
