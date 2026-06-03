-- =============================================================================
-- release_maintenance_work_order · SECURITY DEFINER RPC for the "Release back
-- to queue" path on /mechanic/work-orders.
--
-- Problem:
--   The mechanic UPDATE policy on public.maintenance_work_orders is
--     USING       (assigned_mechanic_id = auth.uid() AND <mechanic role>)
--     WITH CHECK  (assigned_mechanic_id = auth.uid())
--   The release-back path needs to set assigned_mechanic_id = NULL while the
--   row is still owned by the caller. Postgres evaluates WITH CHECK against
--   the NEW row, NULL <> auth.uid(), so the UPDATE is rejected with
--     "new row violates row-level security policy for table maintenance_work_orders"
--   The mechanic UI heuristic-matches "policy" / "row-level security" in error
--   messages to detect "row was reassigned underneath you" races, so every
--   legitimate Release click fires a false "reassigned" toast and auto-closes
--   the sheet — making Release effectively unusable.
--
-- Fix:
--   SECURITY DEFINER function owned by the table owner runs with privileges
--   that bypass RLS WITH CHECK, so we can null assigned_mechanic_id atomically.
--   We then re-impose the access rule inside the function body via an explicit
--   role gate (admin OR (mechanic AND p_mechanic_id = auth.uid())); service_role
--   is exempt as per the project-wide convention (matches claim_maintenance_work_order
--   and enforce_profile_role_change_admin_only).
--
-- Intentional: we do NOT clear labor_hours, labor_notes, or parts_used. Those
-- represent the previous mechanic's actual diagnostic work and are valuable to
-- the next person who claims the WO. Status/timing fields are reset so the
-- queue view treats the row as fresh.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.release_maintenance_work_order(
  p_id          text,
  p_mechanic_id uuid
)
  RETURNS TABLE (
    ok     boolean,
    status text,
    error  text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller            uuid;
  v_role              text;
  v_is_admin          boolean := false;
  v_current_status    text;
  v_current_assignee  uuid;
BEGIN
  v_caller := auth.uid();

  -- Auth: admin / mechanic-for-self only (service_role exempt — keys are
  -- already a trust boundary at the API gateway).
  IF auth.role() <> 'service_role' THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = v_caller;

    IF v_role = 'admin' THEN
      v_is_admin := true;
    ELSIF v_role = 'mechanic' AND p_mechanic_id = v_caller THEN
      v_is_admin := false;
    ELSE
      RAISE EXCEPTION
        'forbidden: only admins or the owning mechanic may release a work order'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- service_role is implicitly admin-level for this RPC
    v_is_admin := true;
  END IF;

  -- Lock the row so we don't race a concurrent claim/complete.
  SELECT mwo.status, mwo.assigned_mechanic_id
    INTO v_current_status, v_current_assignee
  FROM public.maintenance_work_orders mwo
  WHERE mwo.id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'work order not found'::text;
    RETURN;
  END IF;

  -- A non-admin caller may only release a WO they own. This is the rule the
  -- RLS WITH CHECK was meant to enforce; we re-enforce it here explicitly
  -- because SECURITY DEFINER bypasses RLS.
  IF v_current_assignee IS DISTINCT FROM p_mechanic_id AND NOT v_is_admin THEN
    RETURN QUERY SELECT false, v_current_status,
      'not your work order to release'::text;
    RETURN;
  END IF;

  -- Only in-flight rows are releasable. completed / cancelled / queued are
  -- terminal-or-already-released states.
  IF v_current_status NOT IN ('claimed','in_progress') THEN
    RETURN QUERY SELECT false, v_current_status,
      ('cannot release a work order in status ' || v_current_status)::text;
    RETURN;
  END IF;

  UPDATE public.maintenance_work_orders
  SET status               = 'queued',
      assigned_mechanic_id = NULL,
      claimed_at           = NULL,
      started_at           = NULL
  WHERE id = p_id;

  RETURN QUERY SELECT true, 'queued'::text, NULL::text;
END $$;

REVOKE ALL ON FUNCTION public.release_maintenance_work_order(text, uuid)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.release_maintenance_work_order(text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.release_maintenance_work_order(text, uuid) IS
  'Atomically release a claimed/in_progress maintenance_work_orders row back '
  'to the queue (status=queued, assigned_mechanic_id=NULL, claimed_at/started_at=NULL). '
  'SECURITY DEFINER bypasses the mechanic UPDATE policy''s WITH CHECK clause, '
  'which would otherwise reject the assigned_mechanic_id=NULL transition. '
  'Body re-imposes the access rule: admin or service_role may release any WO; '
  'a mechanic may only release their own. Intentionally preserves labor_hours, '
  'labor_notes, and parts_used so the next mechanic inherits prior diagnostic work.';
