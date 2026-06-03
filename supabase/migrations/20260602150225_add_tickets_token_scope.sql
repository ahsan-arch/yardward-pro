-- =============================================================================
-- Add 'tickets' to public.token_scope enum.
--
-- /driver/tickets needs a dedicated scope for QR-scanned customer-handed
-- prepaid ticket-book entries. The existing scopes ('forms','job','shift')
-- do not cover ticket redemption flows.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- PostgreSQL, so this lives in its own migration file. ADD VALUE IF NOT
-- EXISTS is the safe form when the migration is re-applied.
-- =============================================================================

ALTER TYPE public.token_scope ADD VALUE IF NOT EXISTS 'tickets';
