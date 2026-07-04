-- =============================================================================
-- Fix RLS infinite recursion (42P17) on conversation_participants.
--
-- Root cause: cp_participant_select's USING clause (communications_core.sql)
-- ran EXISTS(SELECT 1 FROM conversation_participants ...) — a self-reference
-- that re-applied the same policy recursively, so Postgres raised
--   42P17 "infinite recursion detected in policy for relation
--   conversation_participants"
-- on every GET /conversations, /conversation_participants and /messages (the
-- 500s seen on admin load). The conversations/messages membership policies each
-- EXISTS-query conversation_participants, so they inherited the same failure.
--
-- Fix: a SECURITY DEFINER helper reads conversation_participants with RLS
-- bypassed, breaking the cycle. All participant-membership checks route through
-- it instead of an inline self-referential subquery.
-- =============================================================================

-- ---- SECURITY DEFINER membership helper (RLS-bypassing) ----
CREATE OR REPLACE FUNCTION public.is_conversation_participant(p_conversation_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = p_conversation_id
      AND cp.user_id = auth.uid()
      AND cp.left_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.is_conversation_participant(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_conversation_participant(text) TO authenticated, service_role;

-- ---- conversation_participants: non-recursive SELECT ----
DROP POLICY IF EXISTS cp_participant_select ON public.conversation_participants;
CREATE POLICY cp_participant_select ON public.conversation_participants
  FOR SELECT USING (
    public.is_admin()
    OR user_id = auth.uid()
    OR public.is_conversation_participant(conversation_id)
  );

-- ---- conversations: route membership check through the helper ----
DROP POLICY IF EXISTS conv_participant_select ON public.conversations;
CREATE POLICY conv_participant_select ON public.conversations
  FOR SELECT USING (
    public.is_admin()
    OR public.is_conversation_participant(conversations.id)
  );

-- ---- messages: route membership checks through the helper ----
DROP POLICY IF EXISTS messages_participant_select ON public.messages;
CREATE POLICY messages_participant_select ON public.messages
  FOR SELECT USING (
    public.is_admin()
    OR public.is_conversation_participant(messages.conversation_id)
  );

DROP POLICY IF EXISTS messages_self_insert ON public.messages;
CREATE POLICY messages_self_insert ON public.messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conversation_participant(messages.conversation_id)
  );
