-- =============================================================================
-- Fix: approve_purchase_request always reserved exactly 1 unit, ignoring
-- purchase_requests.quantity (added in 20260716213000_purchase_request_quantity.sql).
--
-- Client feedback: "stock says 2 but I need 4" — the reservation has to be
-- correlated against what the mechanic actually asked for, capped by what's
-- actually free (qty_on_hand - qty_reserved), not a flat 1. A request for 4
-- against 2 free units now reserves 2 (partial coverage) instead of 1; the
-- shortfall (requested - reserved) is what tells the admin a supplier order
-- is still needed for the remainder.
-- =============================================================================

create or replace function public.approve_purchase_request(
  p_id          text,
  p_approver_id uuid
) returns table (
  ok                       boolean,
  pr_status                public.purchase_request_status,
  inventory_decrement_qty  integer,
  matched_inventory_id     text
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
    v_available := v_item.qty_on_hand - v_item.qty_reserved;
    if v_available >= 1 then
      -- Reserve as much of the request as free stock covers, capped at what
      -- was actually asked for (never more than v_pr.quantity, never more
      -- than v_available).
      v_decrement := least(v_available, v_pr.quantity);
      update public.inventory_items
         set qty_reserved = qty_reserved + v_decrement
       where id = v_item.id;
      v_matched_id := v_item.id;
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
  return next;
end;
$$;

revoke all on function public.approve_purchase_request(text, uuid) from public, anon;
grant execute on function public.approve_purchase_request(text, uuid) to authenticated, service_role;

comment on function public.approve_purchase_request(text, uuid) is
  'Atomic PR approval: locks PR + matching inventory row, decrements qty_reserved by min(available, requested quantity), flips status to approved. Idempotent — second caller sees ok=false with current status.';
