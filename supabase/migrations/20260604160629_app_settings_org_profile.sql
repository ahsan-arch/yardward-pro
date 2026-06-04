-- =============================================================================
-- Org-profile fields on the app_settings singleton row.
--
-- The /admin/settings → Organization profile tab was previously a decorative
-- form (defaultValue on every Input, no onChange, no persistence). This
-- migration gives those fields a home so the form can be wired to real state.
--
-- Singleton row id='default' is already RLS-restricted to is_admin() for
-- writes; reads are public (every authed user can see the org name etc.).
-- =============================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS business_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tax_id        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS timezone      text NOT NULL DEFAULT 'America/Toronto',
  ADD COLUMN IF NOT EXISTS currency      text NOT NULL DEFAULT 'CAD';

-- Seed the singleton row with the demo defaults so the first /admin/settings
-- load shows something rather than blank fields. Only updates rows where the
-- columns are still empty so a re-run doesn't clobber real admin edits.
UPDATE public.app_settings
SET
  business_name = COALESCE(NULLIF(business_name, ''), 'FleetOps Haulage Co.'),
  tax_id        = COALESCE(NULLIF(tax_id, ''),        '48 102 877 990'),
  address       = COALESCE(NULLIF(address, ''),       'Yard 7, 22 Quarry Ln'),
  timezone      = COALESCE(NULLIF(timezone, ''),      'America/Toronto'),
  currency      = COALESCE(NULLIF(currency, ''),      'CAD')
WHERE id = 'default';
