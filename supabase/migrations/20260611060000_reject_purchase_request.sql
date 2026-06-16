-- Purchase-request rejection.
--
-- The admin "Reject" button was a UI-only mock no-op (no api method, no RPC) —
-- clicking it just toasted "rejected (mock)" and changed nothing server-side.
-- This adds the missing atomic, admin-gated RPC, mirroring
-- approve_purchase_request exactly: lock the row, act only while still
-- 'pending' (idempotent / race-safe), flip status to 'rejected'.

alter table public.purchase_requests
  add column if not exists rejected_by uuid references public.profiles (id),
  add column if not exists rejection_reason text;

create or replace function public.reject_purchase_request(
  p_id          text,
  p_rejecter_id uuid,
  p_reason      text default null
) returns table (
  ok        boolean,
  -- OUT column is pr_status (NOT status): a `status` OUT param collides with
  -- purchase_requests.status in the WHERE below and raises 'column reference
  -- "status" is ambiguous' — the exact bug migration 20260602080538 fixed for
  -- approve_purchase_request. Keep the names disjoint.
  pr_status public.purchase_request_status
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pr public.purchase_requests%rowtype;
begin
  if not is_admin() then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into v_pr from public.purchase_requests where id = p_id for update;
  if not found then
    raise exception 'purchase_request % not found', p_id using errcode = 'P0002';
  end if;

  -- Idempotency / lost-race guard: only a still-pending PR can be rejected. A
  -- second caller sees the current status and gets ok=false (no side effects).
  if v_pr.status <> 'pending' then
    ok := false;
    pr_status := v_pr.status;
    return next;
    return;
  end if;

  update public.purchase_requests as pr
     set status           = 'rejected',
         rejected_by      = p_rejecter_id,
         rejection_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where pr.id = p_id
     and pr.status = 'pending';  -- belt-and-suspenders: lose cleanly on race

  ok := true;
  pr_status := 'rejected';
  return next;
end;
$$;

revoke all on function public.reject_purchase_request(text, uuid, text) from public, anon;
grant execute on function public.reject_purchase_request(text, uuid, text) to authenticated, service_role;

comment on function public.reject_purchase_request(text, uuid, text) is
  'Atomic PR rejection: admin-only, locks the row, flips pending -> rejected. Idempotent — a second caller gets ok=false with the current status.';
