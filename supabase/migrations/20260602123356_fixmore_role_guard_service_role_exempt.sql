-- =============================================================================
-- Relax enforce_profile_role_change_admin_only to exempt service_role.
--
-- The previous migration added a BEFORE UPDATE OF role trigger on public.profiles
-- that raises insufficient_privilege when public.is_admin() returns false. But
-- is_admin() reads auth.uid() against profiles.role='admin', and for a
-- service_role JWT auth.uid() is NULL — so is_admin() returns false and the
-- trigger rejects every server-side automation update.
--
-- Service role is already a privileged trust boundary at the API gateway, so we
-- exempt it here so future backfill / admin tooling using SUPABASE_SERVICE_ROLE_KEY
-- can fix mis-assigned roles without disabling the trigger.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_profile_role_change_admin_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT (public.is_admin() OR auth.role() = 'service_role') THEN
      RAISE EXCEPTION 'Only admins can change a profile role (attempted % -> %)', OLD.role, NEW.role
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
