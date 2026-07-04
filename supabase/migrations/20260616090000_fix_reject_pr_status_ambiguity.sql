-- Fix: the original reject_purchase_request migration (20260611060000) used OUT
-- column `status`, which collides with public.purchase_requests.status in the
-- function body's UPDATE under plpgsql variable_conflict=error. Postgres raises
-- "column reference 'status' is ambiguous" on EVERY call, so no PR could ever
-- be rejected.
--
-- This must be a SEPARATE migration (not an edit of 20260611060000) for two
-- reasons: (1) that migration was already shipped, and editing an applied
-- migration in place never re-runs on a linked remote — the buggy function
-- stays live; (2) CREATE OR REPLACE FUNCTION cannot rename an existing
-- function's OUT parameters ("cannot change name of input parameter"), so we
-- must DROP first. This mirrors exactly how 20260602080538 fixed the same bug
-- for approve_purchase_request.

drop function if exists public.reject_purchase_request(text, uuid, text);

create or replace function public.reject_purchase_request(
  p_id          text,
  p_rejecter_id uuid,
  p_reason      text default null
) returns table (
  ok        boolean,
  -- OUT column is pr_status (NOT status): a `status` OUT param collides with
  -- purchase_requests.status in the UPDATE below and raises 'column reference
  -- "status" is ambiguous'. Keep the names disjoint, as the approve fix does.
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
  'Atomic PR rejection: admin-only, locks the row, flips pending -> rejected. Idempotent — a second caller gets ok=false with the current status (pr_status).';
