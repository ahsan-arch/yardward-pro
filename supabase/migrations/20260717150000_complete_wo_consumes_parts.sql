-- =============================================================================
-- Completing a work order with parts attached now actually consumes stock.
--
-- Client feedback (Parts item 7 / Mechanic Profile item 5): "No ability to
-- add to work orders" and "stock says 2 but I need 4 — how does the system
-- adjust stock levels... no correlation." The mechanic work-order sheet
-- already lets a mechanic pick parts + qty onto a job (partsUsed jsonb —
-- see 20260602150128_build_maintenance_wo_and_ticket_uses.sql), but nothing
-- ever decremented qty_on_hand for them: a mechanic could record "used 2
-- brake pads" and inventory would still show the pre-job count forever.
--
-- This adds a dedicated completion RPC (same SECURITY DEFINER + row-lock +
-- idempotent-status-check pattern as approve_purchase_request and
-- claim_maintenance_work_order) that, on the ONE-TIME transition to
-- 'completed', decrements qty_on_hand for every part recorded — clamped at
-- 0 so an overstated qty or a stock count that already drifted from a
-- concurrent adjust can't drive it negative. Idempotent: a retried "Mark
-- complete" click (network blip, double-tap) sees the already-completed
-- row and does NOT decrement again.
--
-- Deliberately does not touch qty_reserved: reservations are earmarked
-- against approved purchase requests specifically, and nothing in this
-- schema links a given WO part-use back to which reservation (if any)
-- covered it. Reconciling that is a separate problem this doesn't solve.
-- =============================================================================

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
      update public.inventory_items
         set qty_on_hand = greatest(0, qty_on_hand - v_qty)
       where id = v_item_id;
    end if;
  end loop;

  ok     := true;
  status := 'completed';
  return next;
end;
$$;

revoke all on function public.complete_maintenance_work_order(text, uuid, numeric, text, jsonb, numeric, text) from public, anon;
grant execute on function public.complete_maintenance_work_order(text, uuid, numeric, text, jsonb, numeric, text) to authenticated, service_role;

comment on function public.complete_maintenance_work_order(text, uuid, numeric, text, jsonb, numeric, text) is
  'Atomic WO completion: locks the row, flips it to completed (idempotent — a second call sees ok=true/status=completed without re-decrementing), and consumes qty_on_hand for every part recorded against the job. Triggers trg_inventory_items_notify_low_stock same as any other stock change.';
