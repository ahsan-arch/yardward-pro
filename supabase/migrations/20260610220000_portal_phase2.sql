-- =============================================================================
-- Client portal Phase 2: on-submit notifications + prepaid-ticket debit.
--
--   - clients.portal_notify_sms / portal_notify_emails: per-client recipients
--     for the submit fan-out (gate-guard SMS, receiving-facility email copy).
--   - app_settings.portal_notify_sms / portal_notify_emails: internal staff
--     recipients (John / yard / Nick) notified on EVERY portal submission.
--   - portal_debit_ticket(): service-role-only atomic prepaid-ticket debit
--     used by the client-portal edge function on each submission. Separate
--     from debit_client_ticket() because that RPC requires an admin user
--     JWT (is_admin()) — the portal path runs as service_role with no user.
--     Balance may go negative (trucks keep dumping after the prepay runs
--     out; the negative balance is the signal to invoice the difference).
-- =============================================================================

alter table public.clients
  add column if not exists portal_notify_sms text[] not null default '{}',
  add column if not exists portal_notify_emails text[] not null default '{}';

alter table public.app_settings
  add column if not exists portal_notify_sms text[] not null default '{}',
  add column if not exists portal_notify_emails text[] not null default '{}';

create or replace function public.portal_debit_ticket(
  p_client_id   text,
  p_dump_log_id text,
  p_dump_site   text,
  p_truck       text
)
returns table (ok boolean, enabled boolean, new_balance integer, threshold integer, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled   boolean;
  v_balance   integer;
  v_threshold integer;
begin
  select tickets_enabled, tickets_balance, tickets_threshold
    into v_enabled, v_balance, v_threshold
    from public.clients
   where id = p_client_id
   for update;

  if not found then
    ok := false; enabled := false; new_balance := null; threshold := null;
    error := 'client not found';
    return next; return;
  end if;

  if not v_enabled then
    ok := true; enabled := false; new_balance := v_balance; threshold := v_threshold;
    error := null;
    return next; return;
  end if;

  v_balance := v_balance - 1;
  update public.clients set tickets_balance = v_balance where id = p_client_id;

  insert into public.ticket_transactions
    (id, client_id, kind, qty, balance_after, occurred_at, work_order_id, vehicle_id, dump_site, reason)
  values
    ('TT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
     p_client_id, 'debit', 1, v_balance, now(), null, null,
     coalesce(p_dump_site, ''),
     'Portal dump form ' || coalesce(p_dump_log_id, '?') ||
       case when p_truck is not null and p_truck <> '' then ' · truck ' || p_truck else '' end);

  ok := true; enabled := true; new_balance := v_balance; threshold := v_threshold;
  error := null;
  return next;
end;
$$;

-- Service-role only: the portal edge function is the sole caller. Deny the
-- browser-facing roles outright.
revoke all on function public.portal_debit_ticket(text, text, text, text) from public;
revoke all on function public.portal_debit_ticket(text, text, text, text) from anon;
revoke all on function public.portal_debit_ticket(text, text, text, text) from authenticated;
grant execute on function public.portal_debit_ticket(text, text, text, text) to service_role;
