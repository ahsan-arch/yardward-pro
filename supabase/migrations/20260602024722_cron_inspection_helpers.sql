-- Diagnostic helpers so the service_role JS client can inspect pg_cron without
-- a psql session. Both are security definer + revoked from public/anon so only
-- service_role JWTs can hit them.

create or replace function public.list_cron_jobs()
returns table (jobid bigint, schedule text, jobname text, active boolean, command text)
language sql security definer set search_path = cron, public
as $$
  select jobid, schedule, jobname, active, command
  from cron.job
  order by jobid;
$$;
revoke execute on function public.list_cron_jobs() from public, anon, authenticated;

create or replace function public.recent_cron_runs(p_jobname text default null, p_limit int default 5)
returns table (jobid bigint, runid bigint, job_pid integer, database text, username text, command text, status text, return_message text, start_time timestamptz, end_time timestamptz)
language sql security definer set search_path = cron, public
as $$
  select d.jobid, d.runid, d.job_pid, d.database, d.username, d.command, d.status, d.return_message, d.start_time, d.end_time
  from cron.job_run_details d
  left join cron.job j on j.jobid = d.jobid
  where p_jobname is null or j.jobname = p_jobname
  order by d.start_time desc
  limit p_limit;
$$;
revoke execute on function public.recent_cron_runs(text, int) from public, anon, authenticated;
