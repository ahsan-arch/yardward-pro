-- =============================================================================
-- Fix-pass: prepaid-ticket recording from driver/mechanic flows + realtime for
-- maintenance_work_orders + correct failed-inspection auto-WO trigger.
--
-- Closes 3 CRIT + 1 MED findings from the review:
--
--   CRIT-1  public.debit_client_ticket requires a work_order_id and is admin-
--           gated, so drivers/mechanics recording a prepaid ticket use OUTSIDE
--           the work-order approval flow have nothing to call. New RPC
--           public.record_driver_ticket_use exposes that path: still SECURITY
--           DEFINER, role-gated to driver/mechanic/admin, and writes
--           ticket_transactions.work_order_id = NULL explicitly so the FK to a
--           non-existent work_order can never fail and there is no spurious
--           "WO-NEEDED" sentinel in the data.
--
--   CRIT-2  public.maintenance_work_orders is the mechanic queue but is NOT in
--           the supabase_realtime publication, so /mechanic/work-orders never
--           receives postgres_changes events when a driver flags an inspection
--           and a new row is auto-opened. The mechanic sees a stale queue until
--           they manually refresh. Add the table, idempotently, with REPLICA
--           IDENTITY FULL so DELETE payloads carry the old row (matches the
--           pattern used for jobs/work_orders/notifications in the earlier
--           sprint2_tokens_and_realtime migration).
--
--   CRIT-3  The auto_open_wo_from_failed_inspection trigger fires AFTER INSERT
--           on vehicle_inspections, but api.submitVehicleInspection inserts the
--           parent row FIRST and the inspection_items rows SECOND. So at trigger
--           time the items subquery returns zero rows and the work order is
--           created with the fallback "Driver flagged inspection" description,
--           with none of the actual failed item names or notes. Move the trigger
--           to inspection_items AFTER INSERT and per-row append into the running
--           description on the existing MWO (keyed by idempotency 'insp:<id>').
--
--   MED     The fallback issue_description loses driver-supplied detail. Fixed
--           as a side effect of CRIT-3: each failing item appends itself, so
--           the description reflects the actual failures even if the parent
--           inspection's free-text notes field is empty.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. record_driver_ticket_use · prepaid ticket debit without a work order
-- -----------------------------------------------------------------------------
-- Mirrors debit_client_ticket's column conventions (kind='debit' with a positive
-- qty), but is callable by drivers and mechanics in addition to admins, and
-- explicitly writes work_order_id = NULL so the FK to work_orders is never
-- exercised.
--
-- The clients row is updated with an atomic UPDATE ... RETURNING so concurrent
-- callers serialize on the row lock and balance_after is always consistent
-- with the row's post-state. Negative balances are allowed (matches the
-- existing app behavior). p_tickets is clamped to [1, 50] to bound the
-- blast radius of a typo or a malicious driver.
--
-- ticket_transactions has no created_by column in this schema (see the comment
-- block above debit_client_ticket in 20260602121520_preprod_fixmore_auth_atomicity);
-- the audit trail relies on occurred_at + reason. We still derive v_actor_id
-- so the auth gate has something to check.

CREATE OR REPLACE FUNCTION public.record_driver_ticket_use(
  p_client_id text,
  p_vehicle_id text,
  p_dump_site text,
  p_tickets integer,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  ok             boolean,
  new_balance    integer,
  transaction_id text,
  error          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id        uuid;
  v_role            text;
  v_is_service_role boolean;
  v_tickets_enabled boolean;
  v_new_balance     integer;
  v_txn_id          text;
  v_vehicle_id      text;
BEGIN
  v_actor_id := auth.uid();
  v_is_service_role := auth.role() = 'service_role';

  -- Auth: a real session must back the call unless this is a service_role caller
  -- (server-side mover, edge function, etc.).
  IF v_actor_id IS NULL AND NOT v_is_service_role THEN
    RAISE EXCEPTION 'record_driver_ticket_use requires an authenticated session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Role gate: only driver / mechanic / admin. service_role is exempt because
  -- keys ARE the trust boundary for that path.
  IF NOT v_is_service_role THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = v_actor_id;
    IF v_role IS NULL OR v_role NOT IN ('driver', 'mechanic', 'admin') THEN
      RAISE EXCEPTION 'record_driver_ticket_use forbidden for role %', coalesce(v_role, 'unknown')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Clamp the ticket count to a sane range. Out of range is a programming
  -- error or a typo in the UI; either way we'd rather error than persist it.
  IF p_tickets IS NULL OR p_tickets < 1 OR p_tickets > 50 THEN
    RAISE EXCEPTION 'p_tickets must be between 1 and 50 (got %)', p_tickets
      USING ERRCODE = 'check_violation';
  END IF;

  -- Validate client exists and is enabled for prepaid tickets BEFORE we mutate
  -- anything. We return a structured row rather than RAISE so the UI can show
  -- a friendly message.
  SELECT tickets_enabled INTO v_tickets_enabled
  FROM public.clients
  WHERE id = p_client_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::integer, NULL::text, 'client not found'::text;
    RETURN;
  END IF;

  IF v_tickets_enabled IS NOT TRUE THEN
    RETURN QUERY SELECT false, NULL::integer, NULL::text,
      'client is not enabled for prepaid tickets'::text;
    RETURN;
  END IF;

  -- Optional vehicle: if supplied (and non-empty), it must exist. We pre-clean
  -- to NULL once here so the downstream INSERT and the validation read agree.
  v_vehicle_id := NULLIF(trim(coalesce(p_vehicle_id, '')), '');

  IF v_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = v_vehicle_id) THEN
      RETURN QUERY SELECT false, NULL::integer, NULL::text, 'vehicle not found'::text;
      RETURN;
    END IF;
  END IF;

  -- Atomic debit: the row lock serializes concurrent callers and the RETURNING
  -- clause hands us a post-state that is guaranteed consistent with the row.
  UPDATE public.clients
     SET tickets_balance = tickets_balance - p_tickets
   WHERE id = p_client_id
   RETURNING tickets_balance INTO v_new_balance;

  -- v_txn_id is namespaced TT- to match debit_client_ticket and ticket_transactions
  -- elsewhere. clock_timestamp() advances even inside a transaction so two calls
  -- in quick succession can't collide on the md5.
  v_txn_id := 'TT-' || substr(md5(clock_timestamp()::text || p_client_id), 1, 10);

  INSERT INTO public.ticket_transactions (
    id,
    client_id,
    kind,
    qty,
    balance_after,
    occurred_at,
    work_order_id,
    vehicle_id,
    dump_site,
    reason
  ) VALUES (
    v_txn_id,
    p_client_id,
    'debit',
    p_tickets,
    v_new_balance,
    now(),
    NULL,              -- explicit: this is the key fix, no WO is required
    v_vehicle_id,
    coalesce(p_dump_site, ''),
    coalesce(nullif(trim(p_reason), ''), 'Driver-recorded prepaid ticket use')
  );

  RETURN QUERY SELECT true, v_new_balance, v_txn_id, NULL::text;
END $$;

REVOKE ALL ON FUNCTION public.record_driver_ticket_use(text, text, text, integer, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_driver_ticket_use(text, text, text, integer, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.record_driver_ticket_use(text, text, text, integer, text) IS
  'Records a prepaid-ticket debit for a client without requiring a work order. '
  'SECURITY DEFINER, role-gated to driver/mechanic/admin. Writes '
  'ticket_transactions with kind=debit, positive qty, work_order_id=NULL, '
  'balance_after consistent with the post-debit clients.tickets_balance.';


-- -----------------------------------------------------------------------------
-- 2. supabase_realtime publication: add maintenance_work_orders
-- -----------------------------------------------------------------------------
-- Mirrors the idempotent pattern from 20260602071614_sprint2_tokens_and_realtime
-- (the do-block catching duplicate_object / undefined_object). REPLICA IDENTITY
-- FULL is needed so DELETE realtime events carry the old row (mechanics in the
-- UI need vehicle_id to update their local cache).

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.maintenance_work_orders;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END
$$;

ALTER TABLE public.maintenance_work_orders REPLICA IDENTITY FULL;


-- -----------------------------------------------------------------------------
-- 3. Failed-inspection trigger · move from parent to items, append per-row
-- -----------------------------------------------------------------------------
-- The previous trigger fired AFTER INSERT on vehicle_inspections, BEFORE the
-- inspection_items children were written by api.submitVehicleInspection, so
-- the items subquery was always empty and the MWO ended up with the fallback
-- "Driver flagged inspection" description.
--
-- The new trigger fires on inspection_items AFTER INSERT for each row whose
-- status='issue'. The first failing item creates the MWO (keyed by
-- 'insp:<inspection_id>' so retries collide cleanly). Each subsequent failing
-- item appends to the same MWO's issue_description. Because per-row triggers
-- fire in insertion order, the description ends up with all failed items
-- concatenated in the order the UI listed them.
--
-- We still confirm vehicle_inspections.flagged=true defensively before creating
-- a work order — a non-flagged inspection that happened to land with status=issue
-- items would be a data anomaly we'd rather ignore than amplify.

DROP TRIGGER IF EXISTS vehicle_inspections_auto_open_wo ON public.vehicle_inspections;
DROP FUNCTION IF EXISTS public.auto_open_wo_from_failed_inspection();

CREATE OR REPLACE FUNCTION public.auto_open_wo_from_failed_item()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_insp        public.vehicle_inspections%ROWTYPE;
  v_idem_key    text;
  v_wo_id       text;
  v_existing_id text;
  v_existing    text;
  v_segment     text;
BEGIN
  -- Only act on failing items. Belt-and-braces with the trigger WHEN clause.
  IF NEW.status IS DISTINCT FROM 'issue' THEN
    RETURN NEW;
  END IF;

  -- Parent must exist and be flagged. If a non-flagged inspection somehow
  -- carries an 'issue' item we silently no-op rather than open a work order
  -- that won't match the driver's intent.
  SELECT * INTO v_insp
  FROM public.vehicle_inspections
  WHERE id = NEW.inspection_id;

  IF NOT FOUND OR v_insp.flagged IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Build this item's description segment: name optionally suffixed with notes.
  v_segment := NEW.name;
  IF coalesce(trim(NEW.notes), '') <> '' THEN
    v_segment := v_segment || ': ' || trim(NEW.notes);
  END IF;

  v_idem_key := 'insp:' || NEW.inspection_id;

  -- Look up an existing MWO for this inspection. The partial UNIQUE index on
  -- idempotency_key makes this a fast scan.
  SELECT id, issue_description INTO v_existing_id, v_existing
  FROM public.maintenance_work_orders
  WHERE idempotency_key = v_idem_key
  LIMIT 1;

  IF FOUND THEN
    -- Append this segment, comma-separated, deduping the trivial repeat case.
    UPDATE public.maintenance_work_orders
       SET issue_description = CASE
             WHEN v_existing = '' OR v_existing IS NULL THEN v_segment
             WHEN position(v_segment IN v_existing) > 0   THEN v_existing
             ELSE v_existing || ', ' || v_segment
           END
     WHERE id = v_existing_id;
    RETURN NEW;
  END IF;

  -- First failing item for this inspection: create the MWO.
  v_wo_id := 'MWO-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);

  INSERT INTO public.maintenance_work_orders (
    id,
    vehicle_id,
    reported_by,
    reported_from,
    source_inspection_id,
    issue_description,
    priority,
    status,
    idempotency_key
  ) VALUES (
    v_wo_id,
    v_insp.vehicle_id,
    v_insp.driver_id,
    'inspection',
    v_insp.id,
    v_segment,
    'high',
    'queued',
    v_idem_key
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  -- If the ON CONFLICT short-circuited (a parallel insertion path won the race)
  -- catch up by appending to whatever row landed.
  IF NOT FOUND THEN
    UPDATE public.maintenance_work_orders
       SET issue_description = CASE
             WHEN issue_description = '' OR issue_description IS NULL THEN v_segment
             WHEN position(v_segment IN issue_description) > 0          THEN issue_description
             ELSE issue_description || ', ' || v_segment
           END
     WHERE idempotency_key = v_idem_key;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER inspection_items_auto_open_wo
  AFTER INSERT ON public.inspection_items
  FOR EACH ROW
  WHEN (NEW.status = 'issue')
  EXECUTE FUNCTION public.auto_open_wo_from_failed_item();

COMMENT ON FUNCTION public.auto_open_wo_from_failed_item() IS
  'Per-row inspection_items trigger that opens (or appends to) a '
  'maintenance_work_orders row when an inspection_items row with status=issue '
  'is inserted under a flagged vehicle_inspections parent. Idempotency keyed '
  'on insp:<inspection_id> so concurrent inserts collapse onto a single MWO.';
