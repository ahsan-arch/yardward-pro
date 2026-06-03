-- Client follow-up features migration
-- Covers: draft jobs, shift checklist kinds, app settings singleton,
-- pre-trip lockout tracking, time entry inspection correlation, and PO vehicle linkage.

-- 1. EXTEND ENUM job_status with 'draft'
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'draft' BEFORE 'scheduled';

-- 2. ADD COLUMN to tool_checklist_submissions: kind (start/end of shift)
ALTER TABLE public.tool_checklist_submissions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'start_of_shift'
    CHECK (kind IN ('start_of_shift', 'end_of_shift'));

-- 3. CREATE TABLE public.app_settings (singleton)
CREATE TABLE IF NOT EXISTS public.app_settings (
  id text PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  gps_tolerance_minutes integer NOT NULL DEFAULT 15,
  overtime_warning_hours numeric(5,2) NOT NULL DEFAULT 40,
  overtime_alert_hours numeric(5,2) NOT NULL DEFAULT 44,
  inspection_min_duration_seconds integer NOT NULL DEFAULT 780,  -- 13 min
  inspection_max_duration_seconds integer NOT NULL DEFAULT 1200, -- 20 min
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Admins can SELECT, INSERT, UPDATE
DROP POLICY IF EXISTS app_settings_admin_select ON public.app_settings;
CREATE POLICY app_settings_admin_select ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS app_settings_admin_insert ON public.app_settings;
CREATE POLICY app_settings_admin_insert ON public.app_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS app_settings_admin_update ON public.app_settings;
CREATE POLICY app_settings_admin_update ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Authenticated users can SELECT (drivers need to read tolerance values)
DROP POLICY IF EXISTS app_settings_authenticated_select ON public.app_settings;
CREATE POLICY app_settings_authenticated_select ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (true);

-- Seed the singleton row
INSERT INTO public.app_settings (id) VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- 4. ADD COLUMN to vehicles: last_pretrip_at
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS last_pretrip_at timestamptz;

-- 5. ADD COLUMNS to time_entries: pretrip_inspection_id and flag_tolerance_minutes
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS pretrip_inspection_id text REFERENCES public.vehicle_inspections(id),
  ADD COLUMN IF NOT EXISTS flag_tolerance_minutes integer;

-- 6. ADD COLUMN to purchase_requests: vehicle_id (the truck the part is for)
ALTER TABLE public.purchase_requests
  ADD COLUMN IF NOT EXISTS vehicle_id text REFERENCES public.vehicles(id);
