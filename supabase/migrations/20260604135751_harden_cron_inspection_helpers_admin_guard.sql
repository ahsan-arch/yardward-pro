-- =============================================================================
-- Harden public.list_cron_jobs() and public.recent_cron_runs() with explicit
-- is_admin() guards. Defense in depth: the original definitions REVOKE EXECUTE
-- from public/anon/authenticated, but anyone with execute grants (e.g. a future
-- accidental GRANT, or a SECURITY DEFINER caller without their own role check)
-- would otherwise be able to enumerate cron schedules + run details.
--
-- Both functions remain SECURITY DEFINER so they can read cron.* tables, but
-- the body now raises insufficient_privilege when called by a non-admin role.
-- Service_role is exempt (auth.role() = 'service_role') so existing cron jobs
-- + automation still works.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.list_cron_jobs()
RETURNS TABLE (jobid bigint, schedule text, jobname text, active boolean, command text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = cron, public, pg_temp
AS $$
BEGIN
  IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION 'list_cron_jobs requires admin role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT j.jobid, j.schedule, j.jobname, j.active, j.command
    FROM cron.job j
    ORDER BY j.jobid;
END $$;
REVOKE EXECUTE ON FUNCTION public.list_cron_jobs() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_cron_jobs() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.recent_cron_runs(p_jobname text DEFAULT NULL, p_limit int DEFAULT 5)
RETURNS TABLE (jobid bigint, runid bigint, job_pid integer, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = cron, public, pg_temp
AS $$
BEGIN
  IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
    RAISE EXCEPTION 'recent_cron_runs requires admin role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.jobid, d.runid, d.job_pid, d.database, d.username, d.command, d.status, d.return_message, d.start_time, d.end_time
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE p_jobname IS NULL OR j.jobname = p_jobname
    ORDER BY d.start_time DESC
    LIMIT p_limit;
END $$;
REVOKE EXECUTE ON FUNCTION public.recent_cron_runs(text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recent_cron_runs(text, int) TO authenticated, service_role;
