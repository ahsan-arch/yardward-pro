-- integration_alerts drift fix.
--
-- The table was created (20260602032849) with only (id, kind, message, context,
-- resolved_at, created_at). But the edge functions that USE it insert/query
-- three columns that were never added to the schema:
--   - source     (14 insert sites: qbo-push-time, qbo-push-invoice,
--                 geotab-sync-locations, tender-scrape, qbo-oauth, …)
--   - severity   (35 insert sites)
--   - integration (queried by integrations-probe to group "last error" history
--                 per integration name)
--
-- Result before this migration: every alert insert that names source/severity
-- hits PostgREST "column does not exist" (400) and is swallowed by the callers'
-- try/catch — so operational alerting (QBO refresh failures, payroll-push
-- failures, scrape failures) silently records NOTHING, and the integrations
-- dashboard's lastError column is always blank.
--
-- Additive + idempotent: `add column if not exists` is a no-op if the columns
-- were already added out-of-band on the live DB, so this is safe to apply
-- anywhere. All three are nullable so existing rows and any insert that omits
-- them keep working.

alter table public.integration_alerts
  add column if not exists source text,
  add column if not exists severity text default 'error',
  add column if not exists integration text;

-- The probe filters by created_at and groups by integration; a small index
-- keeps that history lookup cheap as the table grows.
create index if not exists integration_alerts_integration_created_idx
  on public.integration_alerts (integration, created_at desc);
