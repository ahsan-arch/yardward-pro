-- Sprint 3 fix-more: PR approval atomicity + idempotency.
-- The current approvePurchaseRequest does a SELECT for the matching inventory
-- item, then UPDATEs purchase_requests, then UPDATEs inventory_items in three
-- separate round-trips. Two issues:
--   1. Non-idempotent: a double-click re-runs the whole flow, double-reserving
--      one extra unit of stock on every retry.
--   2. Non-transactional: if the PR UPDATE fails after the inventory bump, we
--      strand a dangling qty_reserved with no compensating decrement.
--
-- Wrap both in a SECURITY DEFINER RPC that runs in one transaction and gates
-- on status='pending' so a race loses cleanly.

create or replace function public.approve_purchase_request(
  p_id          text,
  p_approver_id uuid
) returns table (
  ok                       boolean,
  status                   public.purchase_request_status,
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
  v_decrement    integer := 0;
  v_matched_id   text;
begin
  if not is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  -- Idempotency guard: only operate when the PR is still pending. A second
  -- caller (or a double-click) sees the row already approved/ordered/rejected
  -- and gets ok=false back with the current status, so the UI can show the
  -- current state without any side-effects.
  select * into v_pr from public.purchase_requests where id = p_id for update;
  if not found then
    raise exception 'purchase_request % not found', p_id using errcode = 'P0002';
  end if;
  if v_pr.status <> 'pending' then
    ok                      := false;
    status                  := v_pr.status;
    inventory_decrement_qty := coalesce(v_pr.inventory_decrement_qty, 0);
    matched_inventory_id    := null;
    return next;
    return;
  end if;

  -- Best-effort inventory match. Same fuzzy strategy the JS layer used so we
  -- preserve behavior: name OR sku ILIKE %item%. The FOR UPDATE locks the
  -- matching row so a concurrent transaction can't allocate the same unit.
  v_search := '%' || coalesce(v_pr.item, '') || '%';
  select * into v_item
    from public.inventory_items
   where name ilike v_search or sku ilike v_search
   order by (qty_on_hand - qty_reserved) desc, name asc
   limit 1
   for update;

  if found and (v_item.qty_on_hand - v_item.qty_reserved) >= 1 then
    update public.inventory_items
       set qty_reserved = qty_reserved + 1
     where id = v_item.id;
    v_decrement  := 1;
    v_matched_id := v_item.id;
  end if;

  -- Now flip the PR. If anything below this throws, the prior inventory bump
  -- rolls back automatically because we're in one transaction.
  update public.purchase_requests
     set status                  = 'approved',
         approved_by             = p_approver_id,
         inventory_decrement_qty = v_decrement
   where id = p_id
     and status = 'pending';  -- belt-and-suspenders: lose cleanly on race

  if not found then
    -- Lost the race: the FOR UPDATE on the PR row should have prevented this,
    -- but if a previous transaction beat us we error out so the caller sees
    -- the failure (rather than silently leaving the inventory bump in place
    -- — except we're in one tx, so the bump would also roll back on raise).
    raise exception 'purchase_request % was modified concurrently', p_id
      using errcode = '40001';
  end if;

  ok                      := true;
  status                  := 'approved';
  inventory_decrement_qty := v_decrement;
  matched_inventory_id    := v_matched_id;
  return next;
end;
$$;

revoke all on function public.approve_purchase_request(text, uuid) from public, anon;
grant execute on function public.approve_purchase_request(text, uuid) to authenticated, service_role;

comment on function public.approve_purchase_request(text, uuid) is
  'Atomic PR approval: locks PR + matching inventory row, decrements qty_reserved iff stock available, flips status to approved. Idempotent — second caller sees ok=false with current status.';
