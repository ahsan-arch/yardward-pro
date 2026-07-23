-- =============================================================================
-- Untracked / non-stock parts — client's #1 Fleetio complaint.
--
-- Client feedback (Fleetio Pressure Points #3, Parts #11, Mechanic Profile
-- #11): Fleetio's FIFO rule forces every received part into strict qty
-- tracking. For one-off/consumable purchases that aren't stocked, this
-- produces a stores count that's wildly wrong ("300 parts in the stores but
-- the system says we have 580") and the part can never be deleted once
-- tracked. This adds an opt-in escape hatch per part: is_untracked = true
-- means the part is a consumable/non-stock line — qty_on_hand and
-- reorder_point still exist on the row (so the field isn't lost) but are no
-- longer enforced anywhere:
--   - the low-stock trigger never fires for it
--   - completing a work order against it does not decrement qty_on_hand
--   - approving a purchase request against it does not reserve stock
-- Deliberately additive: strict tracking stays the default (is_untracked
-- defaults false) so every existing part keeps today's behavior unchanged.
-- =============================================================================

alter table public.inventory_items
  add column if not exists is_untracked boolean not null default false;

comment on column public.inventory_items.is_untracked is
  'Consumable/non-stock part: qty_on_hand and reorder_point are not enforced (no low-stock alert, no PR reservation, no WO-completion decrement). Client feedback: forcing every part into strict qty tracking (Fleetio''s FIFO rule) produced inventory counts that drifted from reality for one-off purchases.';

-- ---------------------------------------------------------------------------
-- Low-stock trigger: skip untracked rows entirely.
-- ---------------------------------------------------------------------------
create or replace function public.trg_inventory_items_notify_low_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  was_low boolean;
  is_low boolean := (NEW.qty_on_hand <= NEW.reorder_point) and not NEW.is_untracked;
begin
  was_low := (TG_OP = 'UPDATE')
    and (OLD.qty_on_hand <= OLD.reorder_point)
    and not OLD.is_untracked;
  if is_low and not was_low then
    insert into public.notifications (id, user_id, type, body, link, created_at)
    select
      gen_random_uuid()::text,
      p.id,
      'alert',
      format(
        'Low stock: %s (%s) — %s on hand, reorder point %s.',
        NEW.name, NEW.sku, NEW.qty_on_hand, NEW.reorder_point
      ),
      '/admin/inventory',
      now()
    from public.profiles p
    where p.role = 'admin';
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Work-order completion: skip qty_on_hand decrement for untracked parts
-- (and untracked BOM components).
-- ---------------------------------------------------------------------------
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
           where id = v_comp.component_item_id
             and not coalesce(is_untracked, false);
        end loop;
      else
        update public.inventory_items
           set qty_on_hand = greatest(0, qty_on_hand - v_qty)
         where id = v_item_id
           and not coalesce(is_untracked, false);
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

-- ---------------------------------------------------------------------------
-- PR approval: skip stock reservation for untracked parts, and tell the
-- caller it matched an untracked part (so the UI doesn't say "0 in stock,
-- place supplier order" for something that was never meant to be tracked).
-- Return signature gained a column, so the function must be dropped first.
-- ---------------------------------------------------------------------------
drop function if exists public.approve_purchase_request(text, uuid);

create or replace function public.approve_purchase_request(
  p_id          text,
  p_approver_id uuid
) returns table (
  ok                       boolean,
  pr_status                public.purchase_request_status,
  inventory_decrement_qty  integer,
  matched_inventory_id     text,
  matched_untracked        boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pr           public.purchase_requests%rowtype;
  v_item         public.inventory_items%rowtype;
  v_search       text;
  v_available    integer;
  v_decrement    integer := 0;
  v_matched_id   text;
  v_untracked    boolean := false;
begin
  if not is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into v_pr from public.purchase_requests where id = p_id for update;
  if not found then
    raise exception 'purchase_request % not found', p_id using errcode = 'P0002';
  end if;
  if v_pr.status <> 'pending' then
    ok                      := false;
    pr_status               := v_pr.status;
    inventory_decrement_qty := coalesce(v_pr.inventory_decrement_qty, 0);
    matched_inventory_id    := null;
    matched_untracked       := false;
    return next;
    return;
  end if;

  v_search := '%' || coalesce(v_pr.item, '') || '%';
  select * into v_item
    from public.inventory_items ii
   where ii.name ilike v_search or ii.sku ilike v_search
   order by (ii.qty_on_hand - ii.qty_reserved) desc, ii.name asc
   limit 1
   for update;

  if found then
    if v_item.is_untracked then
      v_untracked  := true;
      v_matched_id := v_item.id;
    else
      v_available := v_item.qty_on_hand - v_item.qty_reserved;
      if v_available >= 1 then
        v_decrement := least(v_available, v_pr.quantity);
        update public.inventory_items
           set qty_reserved = qty_reserved + v_decrement
         where id = v_item.id;
        v_matched_id := v_item.id;
      end if;
    end if;
  end if;

  update public.purchase_requests pr
     set status                  = 'approved',
         approved_by             = p_approver_id,
         inventory_decrement_qty = v_decrement
   where pr.id = p_id
     and pr.status = 'pending';

  if not found then
    raise exception 'purchase_request % was modified concurrently', p_id
      using errcode = '40001';
  end if;

  ok                      := true;
  pr_status               := 'approved';
  inventory_decrement_qty := v_decrement;
  matched_inventory_id    := v_matched_id;
  matched_untracked       := v_untracked;
  return next;
end;
$$;

revoke all on function public.approve_purchase_request(text, uuid) from public, anon;
grant execute on function public.approve_purchase_request(text, uuid) to authenticated, service_role;

comment on function public.approve_purchase_request(text, uuid) is
  'Atomic PR approval: locks PR + matching inventory row. Untracked (consumable) matches skip reservation entirely (matched_untracked=true, decrement=0); tracked matches reserve min(available, requested quantity) as before. Idempotent — second caller sees ok=false with current status.';

notify pgrst, 'reload schema';
