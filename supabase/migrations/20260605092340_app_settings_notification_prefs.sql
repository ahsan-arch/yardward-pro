-- =============================================================================
-- Notification preferences on the app_settings singleton row.
--
-- /admin/settings → Notifications tab previously had 7 hardcoded Switches
-- (defaultChecked only, no state). This migration gives them a home so the
-- form can be wired to real state + a save handler.
--
-- Stored as a single jsonb column so future flags can be added without
-- another ALTER TABLE. Default values match the prior hardcoded UI state.
-- =============================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL DEFAULT '{
    "newJobAssignedSms": true,
    "workOrderAwaitingApproval": true,
    "toolFlaggedOnChecklist": true,
    "gpsMismatchOnTimeEntry": true,
    "poAwaitingApproval": true,
    "vehicleMaintenanceOverdue": false,
    "dailySummaryEmail": false
  }'::jsonb;

-- Seed the singleton with the defaults (only when the column is still
-- {} so re-runs don't clobber real admin edits).
UPDATE public.app_settings
SET notification_preferences = '{
    "newJobAssignedSms": true,
    "workOrderAwaitingApproval": true,
    "toolFlaggedOnChecklist": true,
    "gpsMismatchOnTimeEntry": true,
    "poAwaitingApproval": true,
    "vehicleMaintenanceOverdue": false,
    "dailySummaryEmail": false
  }'::jsonb
WHERE id = 'default' AND (notification_preferences IS NULL OR notification_preferences = '{}'::jsonb);
