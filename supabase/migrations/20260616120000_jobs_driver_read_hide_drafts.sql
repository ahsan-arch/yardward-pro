-- Fix: draft jobs are not private from drivers at the database.
--
-- The original jobs_driver_read policy (20260601180203_rls_policies.sql) was
-- `driver_id = auth.uid()` with no status filter, so an assigned driver could
-- read an unpublished DRAFT job through the API even though the admin UI hides
-- drafts and "publish" is described as the moment a driver first sees the job.
-- Add the status guard so drafts are invisible to drivers until published.
drop policy if exists jobs_driver_read on public.jobs;
create policy jobs_driver_read on public.jobs
  for select using (driver_id = auth.uid() and status <> 'draft');
