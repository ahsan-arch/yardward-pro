-- Adds realm_id to qbo_oauth_tokens.
--
-- Why this is needed: the QBO API host's path includes the company's realm
-- (e.g. /v3/company/<realm_id>/invoice). Every QBO push needs it. The
-- shared helper at supabase/functions/_shared/qbo-oauth.ts already SELECTs
-- realm_id from this table (line 116 reads `realm_id` from the fast-path
-- row) — but the column was missing in the original schema, so every QBO
-- API call would have thrown a column-does-not-exist error.
--
-- The original migration (20260602032849) shipped without it, and the
-- follow-up safety migration (20260602085611) added access_token +
-- access_token_expires_at but missed realm_id. This patches that gap.
--
-- We make the column nullable because the singleton row may exist with
-- only a partial OAuth payload (typically during initial onboarding when
-- the refresh_token has been seeded but realm_id is awaiting the first
-- successful OAuth handshake). Code that needs realm_id is responsible
-- for handling NULL by surfacing "QBO not fully connected — paste your
-- Intuit OAuth Playground output via the supabase db query CLI or via
-- the Integrations tab" to the admin.

alter table public.qbo_oauth_tokens
  add column if not exists realm_id text;

comment on column public.qbo_oauth_tokens.realm_id is
  'QBO company id (a.k.a. realm_id) returned by Intuit''s OAuth handshake. Required for every API call to /v3/company/<realm_id>/*. Nullable so the singleton row can exist mid-onboarding.';
