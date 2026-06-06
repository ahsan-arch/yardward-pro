-- =============================================================================
-- Phase 3 hardening — replay protection + message body cap
--
-- Driven by the adversarial security review of twilio-conversations-webhook:
--
-- 1. webhook_replay_log — every accepted webhook hash gets one row. Future
--    webhooks with the same hash are rejected as replays. Defends against
--    a leaked-payload replay attacker who would otherwise be able to flip
--    delivery status, re-add removed participants, close active threads,
--    etc.
--
-- 2. messages.body length CHECK — bounds Realtime payload size + table
--    bloat from hostile MMS. The 8000 char cap leaves headroom for
--    long MMS but stays well inside Realtime's 1MB per-change limit.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.webhook_replay_log (
  id text PRIMARY KEY,
  source text NOT NULL,
  payload_hash text NOT NULL,
  event_type text,
  twilio_message_sid text,
  twilio_conversation_sid text,
  twilio_participant_sid text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  resulted_in_message_id text REFERENCES public.messages(id) ON DELETE SET NULL,
  UNIQUE (source, payload_hash)
);

CREATE INDEX IF NOT EXISTS webhook_replay_log_first_seen_idx
  ON public.webhook_replay_log (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS webhook_replay_log_event_type_idx
  ON public.webhook_replay_log (event_type, first_seen_at DESC) WHERE event_type IS NOT NULL;

ALTER TABLE public.webhook_replay_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_replay_log_admin_select ON public.webhook_replay_log;
CREATE POLICY webhook_replay_log_admin_select ON public.webhook_replay_log
  FOR SELECT USING (public.is_admin());

-- messages.body length cap. The 8000 char ceiling sits well under Realtime's
-- 1MB per-change payload limit while leaving headroom for long MMS bodies.
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_body_length_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_body_length_check
  CHECK (length(body) <= 8000);
