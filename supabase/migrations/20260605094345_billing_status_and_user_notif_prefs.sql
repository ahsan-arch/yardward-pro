-- =============================================================================
-- 1. Billing subscription state on app_settings.
--    /admin/settings → Billing tab previously hardcoded plan name, renewal
--    date, seat counts, etc. + Cancel button just toasted. This gives those
--    fields a real home so Cancel actually marks the subscription for
--    cancellation and admin can track its status.
--
-- 2. Per-user notification preferences on profiles.
--    /driver/profile → Notifications row was toast-only. Per-user prefs are
--    stored as jsonb on profiles so drivers can opt in/out of channels
--    independently of the org-wide settings on app_settings.
--
-- 3. support_tickets table for /driver/profile → Help & support row.
-- =============================================================================

-- ---- Billing ----
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS billing_plan_name text NOT NULL DEFAULT 'Fleet — up to 25 drivers',
  ADD COLUMN IF NOT EXISTS billing_renewal_date date,
  ADD COLUMN IF NOT EXISTS billing_seats_limit integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS billing_vehicles_limit integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'active'
    CHECK (billing_status IN ('active','cancel-requested','cancelled','past-due')),
  ADD COLUMN IF NOT EXISTS billing_cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_cancel_reason text;

UPDATE public.app_settings
SET billing_renewal_date = CURRENT_DATE + interval '1 year'
WHERE id = 'default' AND billing_renewal_date IS NULL;

-- ---- Per-user notification preferences ----
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{
    "newJobAssignedSms": true,
    "workOrderAwaitingApproval": true,
    "toolFlaggedOnChecklist": true,
    "shiftReminders": true,
    "maintenanceAlerts": true,
    "dailySummaryEmail": false
  }'::jsonb;

-- ---- support_tickets ----
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id text PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution_notes text
);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx ON public.support_tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON public.support_tickets(status, created_at DESC);

DROP POLICY IF EXISTS support_tickets_author_select ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_author_insert ON public.support_tickets;
DROP POLICY IF EXISTS support_tickets_admin_all ON public.support_tickets;
CREATE POLICY support_tickets_author_select ON public.support_tickets
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY support_tickets_author_insert ON public.support_tickets
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY support_tickets_admin_all ON public.support_tickets
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---- request_cancel_subscription SECDEF RPC ----
CREATE OR REPLACE FUNCTION public.request_cancel_subscription(p_reason text)
RETURNS TABLE (ok boolean, status text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_status text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'request_cancel_subscription requires admin role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT billing_status INTO v_current_status FROM public.app_settings WHERE id = 'default' FOR UPDATE;
  IF v_current_status = 'cancel-requested' THEN
    ok := false; status := v_current_status; error := 'cancellation already requested';
    RETURN NEXT; RETURN;
  END IF;
  IF v_current_status = 'cancelled' THEN
    ok := false; status := v_current_status; error := 'subscription already cancelled';
    RETURN NEXT; RETURN;
  END IF;

  UPDATE public.app_settings
  SET billing_status = 'cancel-requested',
      billing_cancel_requested_at = now(),
      billing_cancel_reason = NULLIF(trim(p_reason), ''),
      updated_at = now()
  WHERE id = 'default';

  -- 'system' is the closest semantic match in the notification_type enum
  -- (admin-facing platform message). 'billing' is not in the enum and adding
  -- it requires ALTER TYPE in a separate migration.
  INSERT INTO public.notifications (id, user_id, type, body, link, created_at)
  SELECT
    'NT-' || substr(md5(p.id::text || clock_timestamp()::text), 1, 10),
    p.id,
    'system'::notification_type,
    'Subscription cancellation requested' ||
      COALESCE(' — reason: ' || NULLIF(trim(p_reason), ''), ''),
    '/admin/settings?tab=billing',
    now()
  FROM public.profiles p
  WHERE p.role = 'admin';

  ok := true; status := 'cancel-requested'; error := NULL; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.request_cancel_subscription(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_cancel_subscription(text) TO authenticated, service_role;
