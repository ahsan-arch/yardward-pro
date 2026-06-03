-- =============================================================================
-- Build the real mechanic work-order queue + auto-create-from-inspection trigger.
--
-- The existing public.work_orders table is a DRIVER job-completion record
-- (dump_site / weight_tonnes / load_type / approved-rejected), NOT a vehicle
-- repair queue. /mechanic/work-orders has no backing table.
--
-- This migration introduces public.maintenance_work_orders as the queue,
-- with claim/start/complete state, parts/labor capture, audit-trail source
-- columns, idempotent inserts for offline-queue retries, RLS by role, and an
-- atomic claim RPC so two mechanics can't race-claim the same row.
--
-- A trigger on vehicle_inspections (flagged=true) auto-opens a work order
-- so the loop between driver pre-trip flags and the mechanic queue closes
-- without a manual admin step.
--
-- The 'tickets' token_scope addition is in a sibling migration because
-- ALTER TYPE ADD VALUE cannot run inside a transaction.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- maintenance_work_orders · the mechanic queue
-- -----------------------------------------------------------------------------
CREATE TABLE public.maintenance_work_orders (
  id                      text PRIMARY KEY,
  vehicle_id              text NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  reported_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reported_from           text NOT NULL
                          CHECK (reported_from IN ('inspection','admin','driver_note')),
  source_inspection_id    text REFERENCES public.vehicle_inspections(id) ON DELETE SET NULL,
  issue_description       text NOT NULL,
  priority                text NOT NULL DEFAULT 'medium'
                          CHECK (priority IN ('low','medium','high','critical')),
  status                  text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','claimed','in_progress','completed','cancelled')),
  assigned_mechanic_id    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  claimed_at              timestamptz,
  started_at              timestamptz,
  completed_at            timestamptz,
  parts_used              jsonb NOT NULL DEFAULT '[]'::jsonb,
  labor_hours             numeric(8,2) NOT NULL DEFAULT 0,
  labor_notes             text NOT NULL DEFAULT '',
  final_cost              numeric(12,2),
  completion_notes        text,
  idempotency_key         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX maintenance_wo_queue_idx
  ON public.maintenance_work_orders (status, priority, created_at DESC);

CREATE INDEX maintenance_wo_mechanic_idx
  ON public.maintenance_work_orders (assigned_mechanic_id, status);

CREATE INDEX maintenance_wo_vehicle_idx
  ON public.maintenance_work_orders (vehicle_id);

CREATE UNIQUE INDEX maintenance_wo_idempotency_uniq
  ON public.maintenance_work_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- BEFORE UPDATE → bump updated_at
CREATE OR REPLACE FUNCTION public.maintenance_work_orders_set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER maintenance_work_orders_updated_at
  BEFORE UPDATE ON public.maintenance_work_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.maintenance_work_orders_set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders ENABLE ROW LEVEL SECURITY;

-- admin: full access
CREATE POLICY maintenance_wo_admin_all
  ON public.maintenance_work_orders
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- mechanics: see the whole queue
CREATE POLICY maintenance_wo_mechanic_select
  ON public.maintenance_work_orders
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'mechanic'
    )
  );

-- mechanics: update rows they own (claim flow goes via RPC, but allow direct
-- updates to set status, parts_used, labor_hours, labor_notes, final_cost,
-- completion_notes once a row is theirs)
CREATE POLICY maintenance_wo_mechanic_update_own
  ON public.maintenance_work_orders
  FOR UPDATE
  USING (
    assigned_mechanic_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'mechanic'
    )
  )
  WITH CHECK (assigned_mechanic_id = auth.uid());

-- drivers: see their own reports
CREATE POLICY maintenance_wo_driver_select_own
  ON public.maintenance_work_orders
  FOR SELECT
  USING (
    reported_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'driver'
    )
  );

-- drivers: manually flag a vehicle (trigger-driven inspection inserts run as
-- the owning user too, so this same policy covers both manual and trigger paths)
CREATE POLICY maintenance_wo_driver_insert_own
  ON public.maintenance_work_orders
  FOR INSERT
  WITH CHECK (
    reported_by = auth.uid()
    AND reported_from IN ('inspection','driver_note')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'driver'
    )
  );

-- -----------------------------------------------------------------------------
-- claim_maintenance_work_order · atomic claim RPC
--
-- A mechanic taps "Claim". We SELECT FOR UPDATE the row, check it is still
-- queued AND unassigned, and either flip it to claimed (ok=true) or return
-- the current state (ok=false) so the UI can show "already claimed by …".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_maintenance_work_order(
  p_id          text,
  p_mechanic_id uuid
)
  RETURNS TABLE (
    ok                   boolean,
    status               text,
    assigned_mechanic_id uuid,
    error                text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_role        text;
  v_caller      uuid;
  v_row         public.maintenance_work_orders%ROWTYPE;
BEGIN
  v_caller := auth.uid();

  -- Auth: admin / mechanic only (service_role exempt — keys are trust boundary)
  IF auth.role() <> 'service_role' THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = v_caller;
    IF v_role NOT IN ('admin','mechanic') THEN
      RETURN QUERY SELECT false, NULL::text, NULL::uuid,
        'forbidden: only admin or mechanic may claim'::text;
      RETURN;
    END IF;

    -- A mechanic can only claim FOR themselves; admins may claim on behalf of
    -- any mechanic.
    IF v_role = 'mechanic' AND p_mechanic_id <> v_caller THEN
      RETURN QUERY SELECT false, NULL::text, NULL::uuid,
        'forbidden: mechanics can only claim for themselves'::text;
      RETURN;
    END IF;
  END IF;

  -- Verify the target mechanic actually exists and has the right role
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_mechanic_id AND p.role = 'mechanic'
  ) THEN
    RETURN QUERY SELECT false, NULL::text, NULL::uuid,
      'invalid mechanic id'::text;
    RETURN;
  END IF;

  -- Atomic claim
  SELECT * INTO v_row
  FROM public.maintenance_work_orders
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, NULL::uuid,
      'work order not found'::text;
    RETURN;
  END IF;

  IF v_row.assigned_mechanic_id IS NOT NULL OR v_row.status <> 'queued' THEN
    RETURN QUERY SELECT
      false,
      v_row.status,
      v_row.assigned_mechanic_id,
      'already claimed'::text;
    RETURN;
  END IF;

  UPDATE public.maintenance_work_orders
  SET assigned_mechanic_id = p_mechanic_id,
      status               = 'claimed',
      claimed_at           = now()
  WHERE id = p_id;

  RETURN QUERY SELECT true, 'claimed'::text, p_mechanic_id, NULL::text;
END $$;

REVOKE ALL ON FUNCTION public.claim_maintenance_work_order(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.claim_maintenance_work_order(text, uuid)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auto_open_wo_from_failed_inspection · trigger
--
-- When a vehicle_inspections row lands with flagged=true, gather the failed
-- inspection_items (status='issue') and synthesize a work order. issue_description
-- is "name: notes" pairs comma-separated; falls back to vehicle_inspections.notes
-- if no item rows have been written yet (in case the items insert lags).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_open_wo_from_failed_inspection()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_desc      text;
  v_wo_id     text;
BEGIN
  IF NEW.flagged IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  WITH failed AS (
    SELECT name, notes
    FROM public.inspection_items
    WHERE inspection_id = NEW.id AND status = 'issue'
  )
  SELECT string_agg(
           CASE WHEN coalesce(notes,'') = ''
                THEN name
                ELSE name || ': ' || notes
           END,
           ', '
         )
  INTO v_desc
  FROM failed;

  IF v_desc IS NULL OR length(trim(v_desc)) = 0 THEN
    v_desc := coalesce(NULLIF(trim(NEW.notes), ''), 'Driver flagged inspection');
  END IF;

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
    NEW.vehicle_id,
    NEW.driver_id,
    'inspection',
    NEW.id,
    v_desc,
    'high',
    'queued',
    'insp:' || NEW.id
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

  RETURN NEW;
END $$;

CREATE TRIGGER vehicle_inspections_auto_open_wo
  AFTER INSERT ON public.vehicle_inspections
  FOR EACH ROW
  WHEN (NEW.flagged IS TRUE)
  EXECUTE FUNCTION public.auto_open_wo_from_failed_inspection();
