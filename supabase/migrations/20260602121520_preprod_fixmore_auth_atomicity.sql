-- =============================================================================
-- YardwardPro · Pre-prod fix-more pass · auth hardening + atomic RPCs
-- =============================================================================
-- Six independent fixes bundled into a single migration:
--   1. Harden handle_new_auth_user so the client can never self-assign a role
--      via signUp metadata; add a BEFORE UPDATE guard so non-admins can't
--      escalate themselves either.
--   2. SECURITY DEFINER RPC approve_work_order — wraps the 3-step approval
--      (invoice insert -> line item inserts -> work_order status flip) in a
--      single txn so a mid-flight failure can never leave a half-approved row.
--   3. SECURITY DEFINER RPCs debit_client_ticket + top_up_client_tickets —
--      eliminate the read-modify-write race on clients.tickets_balance.
--   4. SECURITY DEFINER RPC create_driver_token — replaces Math.random() with
--      gen_random_bytes() and writes the row inside the same call.
--   5. idempotency_key columns + partial UNIQUE indexes on six tables so the
--      offline-queue retry path can rely on a 23505 collision as the "already
--      inserted" signal.
--   6. invalidate_pretrip_on_fail — when a failed (flagged) vehicle inspection
--      is recorded, immediately NULL the last_pretrip_at stamp so the 12h
--      pass window can't be silently inherited from a prior pass.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. handle_new_auth_user · role-escalation-on-signup
--
-- Before: coalesce((new.raw_user_meta_data->>'role')::user_role, 'driver').
-- raw_user_meta_data is writable by the client via supabase.auth.signUp({
-- options: { data: { role: 'admin' } } }), so any new signup could mint
-- themselves as admin. raw_app_meta_data, by contrast, is only settable
-- through the service_role key or the auth dashboard — it's the correct
-- source of truth for privileged claims.
-- -----------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_requested text;
  v_role      user_role;
  v_name      text;
begin
  -- Only the service_role / auth dashboard can write raw_app_meta_data, so
  -- this is the only trustworthy source for role assignment at signup.
  v_requested := new.raw_app_meta_data->>'role';

  if v_requested in ('admin', 'driver', 'mechanic') then
    v_role := v_requested::user_role;
  else
    v_role := 'driver'::user_role;
  end if;

  -- Name is display-only and is fine to source from raw_user_meta_data.
  v_name := coalesce(
    nullif(new.raw_user_meta_data->>'name', ''),
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, v_name, v_role)
  on conflict (id) do nothing;

  return new;
end $$;

-- Guard trigger: even with a hardened insert, a client with UPDATE on
-- profiles (via the "users can update own profile" RLS policy) could PATCH
-- their own role column. Block any UPDATE that changes role unless the
-- caller is admin.
create or replace function public.enforce_profile_role_change_admin_only()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    if not public.is_admin() then
      raise exception 'Only admins can change a profile role (attempted % -> %)', old.role, new.role
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_role_change_guard on public.profiles;
create trigger trg_profiles_role_change_guard
  before update of role on public.profiles
  for each row
  execute function public.enforce_profile_role_change_admin_only();

-- Backfill audit · run manually after deploying this migration to surface
-- any pre-existing non-driver profiles that might have been minted via the
-- old, unsafe trigger. Investigate any unexpected admin/mechanic rows.
--
--   SELECT id, email, role, created_at
--     FROM public.profiles
--    WHERE role <> 'driver'
--      AND created_at > (now() - interval '90 days');


-- -----------------------------------------------------------------------------
-- 2. approve_work_order · approve-work-order-not-atomic
--
-- Schema notes (from initial_schema.sql):
--   invoice_data:        id, work_order_id, client_id, kind, total,
--                        qbo_sync_status, qbo_invoice_id, created_at
--                        (no doc_number / subtotal / tax / approved_by columns)
--   invoice_line_items:  id uuid default gen_random_uuid(), invoice_data_id,
--                        description, qty, rate, amount, position
--                        (no work_order_id / unit / line_type columns)
--   work_orders:         status, approved_by, approved_at, invoice_data_id
--
-- The RPC therefore differs from the spec sketch — column names are matched
-- to the actual schema so the function will compile against the live db.
-- -----------------------------------------------------------------------------
create or replace function public.approve_work_order(
  p_wo_id       text,
  p_approver_id uuid,
  p_invoice_id  text,
  p_client_id   text,
  p_total       numeric,
  p_line_items  jsonb
)
returns table (ok boolean, invoice_id text, wo_status text, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_status   work_order_status;
  v_existing_invoice text;
begin
  if not public.is_admin() then
    raise exception 'approve_work_order requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the work_order row for the duration of the txn so a concurrent
  -- approve call can't race past the status check.
  select status into v_current_status
    from public.work_orders
   where id = p_wo_id
   for update;

  if not found then
    ok := false; invoice_id := null; wo_status := null;
    error := 'work_order not found';
    return next; return;
  end if;

  if v_current_status <> 'pending' then
    select id into v_existing_invoice
      from public.invoice_data
     where work_order_id = p_wo_id
     limit 1;
    ok := false;
    invoice_id := v_existing_invoice;
    wo_status := v_current_status::text;
    error := 'work_order already ' || v_current_status::text;
    return next; return;
  end if;

  insert into public.invoice_data (
    id, work_order_id, client_id, kind, total, qbo_sync_status, qbo_invoice_id, created_at
  ) values (
    p_invoice_id, p_wo_id, p_client_id, 'work-order', p_total, 'pending', null, now()
  );

  insert into public.invoice_line_items (
    invoice_data_id, description, qty, rate, amount, position
  )
  select
    p_invoice_id,
    (item->>'description')::text,
    (item->>'qty')::numeric,
    (item->>'rate')::numeric,
    (item->>'amount')::numeric,
    coalesce((item->>'position')::integer, (ord - 1)::integer)
  from jsonb_array_elements(p_line_items) with ordinality as t(item, ord);

  update public.work_orders
     set status          = 'approved',
         approved_by     = p_approver_id,
         approved_at     = now(),
         invoice_data_id = p_invoice_id
   where id = p_wo_id;

  ok := true;
  invoice_id := p_invoice_id;
  wo_status := 'approved';
  error := null;
  return next;
end $$;

revoke all on function public.approve_work_order(text, uuid, text, text, numeric, jsonb)
  from public, anon, authenticated;
grant execute on function public.approve_work_order(text, uuid, text, text, numeric, jsonb)
  to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. debit_client_ticket + top_up_client_tickets · ticket-balance-lost-update
--
-- Schema notes:
--   clients.tickets_balance is integer (can go negative — see api debit code).
--   ticket_transactions:  id text, client_id, kind ticket_txn_kind
--                         ('debit'|'credit'|'adjustment'), qty integer,
--                         balance_after integer, occurred_at,
--                         work_order_id, vehicle_id, dump_site, reason.
--                         (No created_by column.)
--   ticket_replenishments: id text, client_id, invoice_data_id, qty, amount,
--                         triggered_at, auto_billed, qbo_sync_status,
--                         qbo_invoice_id.
--
-- The api.ts debit path uses kind='debit' with a POSITIVE qty (the sign is
-- implicit in the kind enum), so the RPC matches that convention.
-- -----------------------------------------------------------------------------
create or replace function public.debit_client_ticket(
  p_client_id      text,
  p_work_order_id  text,
  p_vehicle_id     text,
  p_dump_site      text,
  p_tickets        integer,
  p_actor_id       uuid
)
returns table (ok boolean, new_balance integer, transaction_id text, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_balance integer;
  v_txn_id      text;
begin
  if not public.is_admin() then
    raise exception 'debit_client_ticket requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_tickets is null or p_tickets <= 0 then
    ok := false; new_balance := null; transaction_id := null;
    error := 'p_tickets must be positive';
    return next; return;
  end if;

  -- Lock the clients row so concurrent debits / top-ups serialize on it.
  -- We allow the balance to go negative (matches the existing app behavior
  -- and the "balance went negative" reason string in api.ts) but the
  -- atomic UPDATE … RETURNING gives us a consistent post-state.
  update public.clients
     set tickets_balance = tickets_balance - p_tickets
   where id = p_client_id
   returning tickets_balance into v_new_balance;

  if not found then
    ok := false; new_balance := null; transaction_id := null;
    error := 'client not found';
    return next; return;
  end if;

  v_txn_id := 'TT-' || substr(md5(clock_timestamp()::text || coalesce(p_work_order_id, '')), 1, 10);

  insert into public.ticket_transactions (
    id, client_id, kind, qty, balance_after, occurred_at,
    work_order_id, vehicle_id, dump_site, reason
  ) values (
    v_txn_id, p_client_id, 'debit', p_tickets, v_new_balance, now(),
    p_work_order_id, p_vehicle_id, nullif(p_dump_site, ''),
    case when v_new_balance < 0
         then 'Work order approved · balance went negative'
         else 'Work order approved' end
  );

  ok := true;
  new_balance := v_new_balance;
  transaction_id := v_txn_id;
  error := null;
  return next;
end $$;

revoke all on function public.debit_client_ticket(text, text, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.debit_client_ticket(text, text, text, text, integer, uuid)
  to authenticated, service_role;


-- top_up_client_tickets · mirrors topUpTickets() in api.ts. Inserts the
-- invoice + invoice line item (replenishment bundle), the ticket_replenishments
-- row, the ticket_transactions row, and bumps clients.tickets_balance — all
-- atomically. Note the ticket_txn_kind enum is ('debit','credit','adjustment'),
-- so the credit kind is used here, NOT 'replenishment' (which is not a valid
-- enum value in this schema).
create or replace function public.top_up_client_tickets(
  p_client_id     text,
  p_qty           integer,
  p_amount        numeric,
  p_invoice_id    text,
  p_replenish_id  text,
  p_auto_billed   boolean,
  p_actor_id      uuid,
  p_notes         text default null
)
returns table (
  ok               boolean,
  new_balance      integer,
  invoice_id       text,
  replenish_id     text,
  transaction_id   text,
  error            text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new_balance integer;
  v_txn_id      text;
  v_qbo_status  qbo_sync_status;
begin
  if not public.is_admin() then
    raise exception 'top_up_client_tickets requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_qty is null or p_qty <= 0 then
    ok := false; new_balance := null; invoice_id := null;
    replenish_id := null; transaction_id := null;
    error := 'p_qty must be positive';
    return next; return;
  end if;

  v_qbo_status := case when p_auto_billed then 'pending'::qbo_sync_status
                                          else 'not-synced'::qbo_sync_status end;

  update public.clients
     set tickets_balance = tickets_balance + p_qty
   where id = p_client_id
   returning tickets_balance into v_new_balance;

  if not found then
    ok := false; new_balance := null; invoice_id := null;
    replenish_id := null; transaction_id := null;
    error := 'client not found';
    return next; return;
  end if;

  insert into public.invoice_data (
    id, work_order_id, client_id, kind, total, qbo_sync_status, qbo_invoice_id, created_at
  ) values (
    p_invoice_id, null, p_client_id, 'ticket-replenishment',
    p_amount, v_qbo_status, null, now()
  );

  insert into public.invoice_line_items (
    invoice_data_id, description, qty, rate, amount, position
  ) values (
    p_invoice_id,
    'Prepaid dump tickets · ' || p_qty::text || ' bundle',
    p_qty,
    case when p_qty > 0 then p_amount / p_qty else 0 end,
    p_amount,
    0
  );

  insert into public.ticket_replenishments (
    id, client_id, invoice_data_id, qty, amount, triggered_at,
    auto_billed, qbo_sync_status, qbo_invoice_id
  ) values (
    p_replenish_id, p_client_id, p_invoice_id, p_qty, p_amount, now(),
    coalesce(p_auto_billed, false), v_qbo_status, null
  );

  v_txn_id := 'TT-' || substr(md5(clock_timestamp()::text || p_client_id), 1, 10);

  insert into public.ticket_transactions (
    id, client_id, kind, qty, balance_after, occurred_at, reason
  ) values (
    v_txn_id, p_client_id, 'credit', p_qty, v_new_balance, now(),
    coalesce(nullif(p_notes, ''),
             case when p_auto_billed then 'Auto-replenishment fired'
                                     else 'Manual top-up by admin' end)
  );

  ok := true;
  new_balance := v_new_balance;
  invoice_id := p_invoice_id;
  replenish_id := p_replenish_id;
  transaction_id := v_txn_id;
  error := null;
  return next;
end $$;

revoke all on function public.top_up_client_tickets(text, integer, numeric, text, text, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.top_up_client_tickets(text, integer, numeric, text, text, boolean, uuid, text)
  to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. create_driver_token · driver-token-math-random-entropy + missing DB write
--
-- Schema notes:
--   driver_tokens:  id text PK, driver_id uuid, token text unique, scoped_to
--                   token_scope (enum 'forms'|'job'|'shift'), expires_at,
--                   used_at, created_at.
--
-- The spec mentioned scopes ('shift','tickets','inspection') but the enum on
-- this schema is ('forms','job','shift'); we validate against the actual
-- enum so the function compiles. (Adding new scopes is a separate change.)
-- -----------------------------------------------------------------------------
create or replace function public.create_driver_token(
  p_driver_id uuid,
  p_scope     text,
  p_hours     integer default 12
)
returns table (id text, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id      text;
  v_token   text;
  v_expires timestamptz;
  v_scope   token_scope;
begin
  if not public.is_admin() then
    raise exception 'create_driver_token requires admin role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_scope not in ('forms', 'job', 'shift') then
    raise exception 'invalid scope %', p_scope;
  end if;
  v_scope := p_scope::token_scope;

  if p_hours is null or p_hours <= 0 then
    raise exception 'p_hours must be positive';
  end if;

  -- CSPRNG: gen_random_bytes from pgcrypto, base64url-encoded so the token
  -- is URL-safe for the /t/<token> landing page.
  v_token := encode(gen_random_bytes(32), 'base64');
  v_token := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  v_id := 'TKN-' || substr(md5(v_token), 1, 10);
  v_expires := now() + (p_hours || ' hours')::interval;

  insert into public.driver_tokens (id, driver_id, token, scoped_to, expires_at, used_at, created_at)
  values (v_id, p_driver_id, v_token, v_scope, v_expires, null, now());

  id := v_id;
  token := v_token;
  expires_at := v_expires;
  return next;
end $$;

revoke all on function public.create_driver_token(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_driver_token(uuid, text, integer)
  to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 5. Idempotency keys for offline-queue retries
--
-- Client mints idempotency_key once at enqueue time. On retry-after-lost-
-- response, the second insert hits a 23505 unique-violation and the api
-- layer treats that as "already inserted, OK" rather than creating a
-- duplicate row. Partial index so existing rows with NULL keys don't
-- collide and so the index is cheap.
-- -----------------------------------------------------------------------------
alter table public.work_orders
  add column if not exists idempotency_key text;
create unique index if not exists work_orders_idempotency_key_uidx
  on public.work_orders (idempotency_key) where idempotency_key is not null;

alter table public.vehicle_inspections
  add column if not exists idempotency_key text;
create unique index if not exists vehicle_inspections_idempotency_key_uidx
  on public.vehicle_inspections (idempotency_key) where idempotency_key is not null;

alter table public.tool_checklist_submissions
  add column if not exists idempotency_key text;
create unique index if not exists tool_checklist_submissions_idempotency_key_uidx
  on public.tool_checklist_submissions (idempotency_key) where idempotency_key is not null;

alter table public.job_logs
  add column if not exists idempotency_key text;
create unique index if not exists job_logs_idempotency_key_uidx
  on public.job_logs (idempotency_key) where idempotency_key is not null;

alter table public.purchase_requests
  add column if not exists idempotency_key text;
create unique index if not exists purchase_requests_idempotency_key_uidx
  on public.purchase_requests (idempotency_key) where idempotency_key is not null;

alter table public.ticket_photos
  add column if not exists idempotency_key text;
create unique index if not exists ticket_photos_idempotency_key_uidx
  on public.ticket_photos (idempotency_key) where idempotency_key is not null;


-- -----------------------------------------------------------------------------
-- 6. invalidate_pretrip_on_fail · failed-inspection-leaves-stale-pass-window
--
-- vehicle_inspections has no `status` column on this schema — it uses a
-- boolean `flagged` (true = fail). The existing trg_vehicles_set_last_pretrip
-- AFTER INSERT trigger only stamps last_pretrip_at when flagged=false; it
-- does NOT clear it on a fail, which means a fail submitted just after a
-- prior pass leaves the 12h window untouched. This trigger closes that gap.
-- -----------------------------------------------------------------------------
create or replace function public.invalidate_pretrip_on_fail()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.flagged = true then
    update public.vehicles
       set last_pretrip_at = null
     where id = new.vehicle_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_invalidate_pretrip_on_fail on public.vehicle_inspections;
create trigger trg_invalidate_pretrip_on_fail
  after insert on public.vehicle_inspections
  for each row
  execute function public.invalidate_pretrip_on_fail();
