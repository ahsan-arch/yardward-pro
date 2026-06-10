-- Schedule portal-weekly-digest every Monday 05:05 UTC (00:05–01:05 in
-- America/Toronto depending on DST) so the clients' Monday-morning report is
-- waiting when they open their inbox — mirrors the Formstack scheduled
-- export this replaces. Same pg_cron + pg_net + vault pattern as
-- geotab-sync-locations.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('portal-weekly-digest-monday')
where exists (select 1 from cron.job where jobname = 'portal-weekly-digest-monday');

select cron.schedule(
  'portal-weekly-digest-monday',
  '5 5 * * 1',
  $$
  select net.http_post(
    url     := 'https://pbyeatgjnrhvfnfiublj.supabase.co/functions/v1/portal-weekly-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
        ''
      )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
