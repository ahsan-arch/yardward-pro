-- Sprint 1 hardening (post-review):
-- 1. Storage RLS: tighten the driver INSERT policy on ticket-photos to ALSO
--    enforce that the path prefix matches the uploader's user id, so a driver
--    can't pollute another driver's folder. owner=auth.uid() alone allowed any
--    path. We use storage.foldername(name)[1] to inspect the first segment.
-- 2. Atomic rate-table upsert: provide a SECURITY DEFINER function so
--    api.upsertRateTable can delete + insert rate_line_items in a single
--    transaction, instead of two round-trips that can leave the table empty
--    on partial failure.

-- ----------------------------------------------------------------------------
-- 1. Tighten driver insert policy for ticket-photos bucket
-- ----------------------------------------------------------------------------
drop policy if exists ticket_photos_driver_insert on storage.objects;
create policy ticket_photos_driver_insert
  on storage.objects
  for insert
  with check (
    bucket_id = 'ticket-photos'
    and auth.role() = 'authenticated'
    and owner = auth.uid()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ----------------------------------------------------------------------------
-- 2. Atomic upsert RPC for rate tables (DELETE + INSERT in one transaction)
-- ----------------------------------------------------------------------------
-- Input: client_id text, line items as jsonb array
--   [{ description, unit, rate, surcharges, position }, ...]
-- Effect:
--   * Upserts a rate_tables row with id = 'RT-' || client_id (idempotent)
--   * Deletes all rate_line_items for that rate_table_id
--   * Inserts the new line items with the supplied positions
--   * Updates clients.rate_table_id = the upserted id
-- Returns: the rate_table_id (text)
-- Security: admin only via is_admin() helper. Runs as definer so it can write
-- across the two tables in one tx even when called by an admin user JWT.
create or replace function public.upsert_client_rate_table(
  p_client_id text,
  p_line_items jsonb
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rt_id text := 'RT-' || p_client_id;
  v_item jsonb;
begin
  if not is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  -- 1. Ensure the rate_tables row exists. Don't touch created_at on update.
  insert into public.rate_tables (id, client_id)
       values (v_rt_id, p_client_id)
  on conflict (id) do nothing;

  -- 2. Wipe + re-insert line items in one transaction (this function body
  --    runs inside an implicit tx). If the inserts fail, the deletes roll back.
  delete from public.rate_line_items where rate_table_id = v_rt_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb))
  loop
    insert into public.rate_line_items (
      rate_table_id, description, unit, rate, surcharges, position
    ) values (
      v_rt_id,
      v_item ->> 'description',
      v_item ->> 'unit',
      (v_item ->> 'rate')::numeric,
      coalesce(v_item -> 'surcharges', '[]'::jsonb),
      coalesce((v_item ->> 'position')::int, 0)
    );
  end loop;

  -- 3. Link the client to this rate table (no-op if already linked).
  update public.clients
     set rate_table_id = v_rt_id
   where id = p_client_id
     and (rate_table_id is null or rate_table_id <> v_rt_id);

  return v_rt_id;
end;
$$;

revoke execute on function public.upsert_client_rate_table(text, jsonb) from public, anon;
grant execute on function public.upsert_client_rate_table(text, jsonb) to authenticated, service_role;
