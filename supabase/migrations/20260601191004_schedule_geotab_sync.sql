-- Schedule geotab-sync-locations to run every minute via pg_cron + pg_net.
-- pg_cron is pre-enabled on Supabase; pg_net is pre-enabled too.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Wrap the SERVICE_ROLE_KEY as a setting so we don't paste it in the SQL.
-- (Supabase exposes the key on the server side; we read via vault if needed.)
-- For now use a Vault secret if present, otherwise a placeholder you swap in.
do $$
declare
  v_key text;
begin
  -- Try Supabase's built-in vault for the service role key
  begin
    select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'service_role_key'
    limit 1;
  exception when others then
    v_key := null;
  end;

  if v_key is null then
    raise notice 'service_role_key not found in vault; you must replace the placeholder below or store it via vault.create_secret.';
  end if;
end $$;

-- Drop any prior schedule with the same name (idempotent re-run)
select cron.unschedule('geotab-sync-every-minute')
where exists (select 1 from cron.job where jobname = 'geotab-sync-every-minute');

select cron.schedule(
  'geotab-sync-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://pbyeatgjnrhvfnfiublj.supabase.co/functions/v1/geotab-sync-locations',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1),
        ''
      )
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
