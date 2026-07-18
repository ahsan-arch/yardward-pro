-- =============================================================================
-- Fix: approve_purchase_request could match a retired/archived part.
--
-- Companion to 20260717170000_archived_parts.sql — a part gets archived
-- because it's superseded or no longer stocked, so an admin approving a PR
-- must never have it silently reserve stock against one. Same function body
-- as 20260716214500_fix_pr_approval_reserves_requested_qty.sql, just with
-- `and not ii.archived` added to the match WHERE clause.
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
   where (ii.name ilike v_search or ii.sku ilike v_search)
     and not ii.archived
   order by (ii.qty_on_hand - ii.qty_reserved) desc, ii.name asc
   limit 1
   for update;

  if found then
    v_available := v_item.qty_on_hand - v_item.qty_reserved;
    if v_available >= 1 then
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
