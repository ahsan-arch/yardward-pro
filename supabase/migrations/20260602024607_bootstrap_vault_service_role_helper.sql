-- Helper to store the service_role key in Vault from a single RPC call.
-- Idempotent: deletes any existing entry first, then re-inserts.
-- security definer so it can write to vault.* even from the service_role JS client.
-- Revoked from public/anon/authenticated so only service_role keys can call.

create or replace function public.bootstrap_vault_service_role_key(p_key text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  delete from vault.secrets where name = 'service_role_key';
  v_id := vault.create_secret(p_key, 'service_role_key', 'Used by pg_cron to invoke edge functions');
  return v_id::text;
end;
$$;

revoke execute on function public.bootstrap_vault_service_role_key(text) from public, anon, authenticated;
