-- =============================================================================
-- Multi-Part / Bill of Materials (BOM).
--
-- Client feedback (Fleetio pressure point #8): "There is no ability to
-- create BOM's (Bill of Materials) this functionality is essential... it
-- allows the ability to create one part number that represents many part
-- numbers. When the part number is entered the full list of parts are
-- represented, when the part number is allocated the full list of parts
-- are allocated and the stock is automatically adjusted... Note: even a
-- decant hose cannot be stored as one part number as it is made up of four
-- part numbers... the part count remains in the original part location,
-- not in the built component."
--
-- A BOM part (inventory_items.is_bom = true) is a virtual/kit designator,
-- not its own physically-stocked row — it has no qty_on_hand of its own
-- that matters. Allocating N of it (recording it as a work-order part)
-- decrements each of ITS COMPONENTS by qty_per * N instead. bom_components
-- is the parent -> component list; a wholesale delete+insert (same pattern
-- as rate_line_items / upsert_client_rate_table) replaces the whole list on
-- every edit rather than reconciling adds/removes for what's always a
-- short list.
-- =============================================================================

alter table public.inventory_items
  add column if not exists is_bom boolean not null default false;

create table public.bom_components (
  id                 uuid primary key default gen_random_uuid(),
  parent_item_id     text not null references public.inventory_items(id) on delete cascade,
  component_item_id  text not null references public.inventory_items(id) on delete restrict,
  qty_per            integer not null check (qty_per > 0),
  created_at         timestamptz not null default now(),
  unique (parent_item_id, component_item_id),
  check (parent_item_id <> component_item_id)
);

create index bom_components_parent_idx on public.bom_components (parent_item_id);

alter table public.bom_components enable row level security;

create policy bom_components_admin_all on public.bom_components
  for all using (is_admin()) with check (is_admin());
create policy bom_components_mechanic_all on public.bom_components
  for all using (current_role_value() = 'mechanic') with check (current_role_value() = 'mechanic');

-- -----------------------------------------------------------------------------
-- set_bom_components · atomic wholesale replace
--
-- Stamps is_bom on the parent row and replaces its component list in one
-- transaction — a network blip mid-edit rolls back the wipe instead of
-- leaving the BOM half-defined. Passing an empty component list with
-- p_is_bom = false is how a part is un-flagged as a BOM.
-- -----------------------------------------------------------------------------
create or replace function public.set_bom_components(
  p_parent_id  text,
  p_is_bom     boolean,
  p_components jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comp jsonb;
begin
  update public.inventory_items set is_bom = p_is_bom where id = p_parent_id;

  delete from public.bom_components where parent_item_id = p_parent_id;

  if p_is_bom then
    for v_comp in select * from jsonb_array_elements(coalesce(p_components, '[]'::jsonb))
    loop
      insert into public.bom_components (parent_item_id, component_item_id, qty_per)
      values (
        p_parent_id,
        v_comp ->> 'componentItemId',
        coalesce((v_comp ->> 'qtyPer')::integer, 1)
      );
    end loop;
  end if;
end;
$$;

revoke all on function public.set_bom_components(text, boolean, jsonb) from public, anon;
grant execute on function public.set_bom_components(text, boolean, jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- complete_maintenance_work_order · BOM-aware stock consumption
--
-- Same function as 20260717150000_complete_wo_consumes_parts.sql, with one
-- change: a parts_used entry whose inventory_item_id is a BOM part expands
-- into its components (each decremented by qty_per * the qty used) instead
-- of decrementing the BOM row itself, which carries no real stock.
-- -----------------------------------------------------------------------------
create or replace function public.complete_maintenance_work_order(
  p_id               text,
  p_mechanic_id      uuid,
  p_labor_hours      numeric,
  p_labor_notes      text,
  p_parts_used       jsonb,
  p_final_cost       numeric,
  p_completion_notes text
) returns table (
  ok     boolean,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wo      public.maintenance_work_orders%rowtype;
  v_part    jsonb;
  v_item_id text;
  v_qty     integer;
  v_is_bom  boolean;
  v_comp    public.bom_components%rowtype;
begin
  select * into v_wo
    from public.maintenance_work_orders
   where id = p_id
   for update;

  if not found then
    raise exception 'maintenance_work_order % not found', p_id using errcode = 'P0002';
  end if;

  if v_wo.assigned_mechanic_id is distinct from p_mechanic_id then
    ok     := false;
    status := v_wo.status;
    return next;
    return;
  end if;

  if v_wo.status = 'completed' then
    ok     := true;
    status := 'completed';
    return next;
    return;
  end if;

  update public.maintenance_work_orders
     set status           = 'completed',
         completed_at     = now(),
         labor_hours      = p_labor_hours,
         labor_notes      = p_labor_notes,
         parts_used       = coalesce(p_parts_used, '[]'::jsonb),
         final_cost       = p_final_cost,
         completion_notes = p_completion_notes
   where id = p_id;

  for v_part in select * from jsonb_array_elements(coalesce(p_parts_used, '[]'::jsonb))
  loop
    v_item_id := v_part ->> 'inventoryItemId';
    v_qty     := coalesce((v_part ->> 'qty')::integer, 0);
    if v_item_id is not null and v_qty > 0 then
      select is_bom into v_is_bom from public.inventory_items where id = v_item_id;
      if v_is_bom then
        for v_comp in select * from public.bom_components where parent_item_id = v_item_id
        loop
          update public.inventory_items
             set qty_on_hand = greatest(0, qty_on_hand - (v_comp.qty_per * v_qty))
           where id = v_comp.component_item_id;
        end loop;
      else
        update public.inventory_items
           set qty_on_hand = greatest(0, qty_on_hand - v_qty)
         where id = v_item_id;
      end if;
    end if;
  end loop;

  ok     := true;
  status := 'completed';
  return next;
end;
$$;

revoke all on function public.complete_maintenance_work_order(text, uuid, numeric, text, jsonb, numeric, text) from public, anon;
grant execute on function public.complete_maintenance_work_order(text, uuid, numeric, text, jsonb, numeric, text) to authenticated, service_role;

notify pgrst, 'reload schema';
