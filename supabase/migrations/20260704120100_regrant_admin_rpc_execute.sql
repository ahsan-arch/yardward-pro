-- =============================================================================
-- Re-assert EXECUTE privileges for the admin approval RPCs.
--
-- Live 500s showed SQLSTATE 42501 "permission denied for function ..." for role
-- `authenticated` on approve_purchase_request, approve_work_order and
-- upsert_client_rate_table. The grants exist in the original migrations, but a
-- later DROP+CREATE / dashboard CREATE OR REPLACE does not preserve grants, so
-- the deployed catalog lost EXECUTE for `authenticated`. These statements are
-- idempotent and match the exact signatures called from src/lib/api.ts. The
-- functions stay SECURITY DEFINER (unchanged) so they can write past the
-- caller's RLS after their internal is_admin() gate.
-- =============================================================================

-- approve_purchase_request(text, uuid)  -- src/lib/api.ts
revoke all on function public.approve_purchase_request(text, uuid) from public, anon;
grant execute on function public.approve_purchase_request(text, uuid) to authenticated, service_role;

-- approve_work_order(text, uuid, text, text, numeric, jsonb)  -- src/lib/api.ts
revoke all on function public.approve_work_order(text, uuid, text, text, numeric, jsonb) from public, anon;
grant execute on function public.approve_work_order(text, uuid, text, text, numeric, jsonb) to authenticated, service_role;

-- upsert_client_rate_table(text, jsonb)  -- src/lib/api.ts
revoke all on function public.upsert_client_rate_table(text, jsonb) from public, anon;
grant execute on function public.upsert_client_rate_table(text, jsonb) to authenticated, service_role;
