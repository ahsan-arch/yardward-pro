-- =============================================================================
-- Communications: tracked Driver ↔ Mechanic conversations with admin oversight.
--
-- Topology (customer-confirmed): driver↔mechanic 1:1 is the default thread.
-- Admins have read-everything visibility via RLS (observe-by-role) but are not
-- auto-added as participants. Admins become active participants only when
-- (a) tagged via tag_admins() RPC, or (b) self-joined via join_conversation().
-- Once participant, they receive notifications + can post messages.
--
-- Phase 1: in-app messaging only. twilio_* SID columns are nullable until
-- the Twilio Conversations API integration lands in Phase 2.
-- =============================================================================

-- ---- conversations ----
CREATE TABLE IF NOT EXISTS public.conversations (
  id text PRIMARY KEY,
  twilio_conversation_sid text UNIQUE,
  topic text NOT NULL CHECK (topic IN ('general','job','vehicle','maintenance')),
  topic_ref_id text,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived','closed')),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  resolution_notes text
);

CREATE INDEX IF NOT EXISTS conversations_status_last_message_idx
  ON public.conversations (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_topic_ref_idx
  ON public.conversations (topic, topic_ref_id) WHERE topic_ref_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_created_by_idx
  ON public.conversations (created_by);

-- ---- conversation_participants ----
CREATE TABLE IF NOT EXISTS public.conversation_participants (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  participant_role text NOT NULL
    CHECK (participant_role IN ('originator','admin','mechanic','driver')),
  twilio_participant_sid text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_at timestamptz,
  UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS cp_user_active_idx
  ON public.conversation_participants (user_id, conversation_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS cp_conversation_idx
  ON public.conversation_participants (conversation_id, joined_at);

-- ---- messages ----
CREATE TABLE IF NOT EXISTS public.messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  twilio_message_sid text,
  idempotency_key text,
  sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  sender_kind text NOT NULL DEFAULT 'in_app'
    CHECK (sender_kind IN ('in_app','sms','system')),
  body text NOT NULL,
  media_paths text[] NOT NULL DEFAULT '{}',
  twilio_media_urls text[] NOT NULL DEFAULT '{}',
  delivery_status text NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued','sent','delivered','failed','received')),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_twilio_sid_uniq
  ON public.messages (twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_idempotency_uniq
  ON public.messages (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conv_created_idx
  ON public.messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON public.messages (sender_id);

-- ---- Trigger: bump conversations.last_message_at on new message ----
CREATE OR REPLACE FUNCTION public.tg_messages_bump_last_message_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.conversations
  SET last_message_at = NEW.created_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS messages_bump_last_message ON public.messages;
CREATE TRIGGER messages_bump_last_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.tg_messages_bump_last_message_at();

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- conversations: participant can SELECT. Admin can do anything (observe-by-role).
DROP POLICY IF EXISTS conv_participant_select ON public.conversations;
DROP POLICY IF EXISTS conv_admin_all ON public.conversations;
CREATE POLICY conv_participant_select ON public.conversations
  FOR SELECT USING (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = conversations.id
        AND cp.user_id = auth.uid()
        AND cp.left_at IS NULL
    )
  );
CREATE POLICY conv_admin_all ON public.conversations
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- conversation_participants: self read + admin all.
-- UPDATE policy is scoped to last_read_at via a column-level convention.
DROP POLICY IF EXISTS cp_self_select ON public.conversation_participants;
DROP POLICY IF EXISTS cp_participant_select ON public.conversation_participants;
DROP POLICY IF EXISTS cp_self_update ON public.conversation_participants;
DROP POLICY IF EXISTS cp_admin_all ON public.conversation_participants;
-- A participant should be able to read all participants of their conversation
-- (so the UI can render the participant pills); admins read all.
CREATE POLICY cp_participant_select ON public.conversation_participants
  FOR SELECT USING (
    public.is_admin()
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.conversation_participants cp2
      WHERE cp2.conversation_id = conversation_participants.conversation_id
        AND cp2.user_id = auth.uid()
        AND cp2.left_at IS NULL
    )
  );
CREATE POLICY cp_self_update ON public.conversation_participants
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
CREATE POLICY cp_admin_all ON public.conversation_participants
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- messages: SELECT for active participants + admin (observe-by-role).
-- INSERT requires sender to be an active participant of that conversation.
DROP POLICY IF EXISTS messages_participant_select ON public.messages;
DROP POLICY IF EXISTS messages_self_insert ON public.messages;
DROP POLICY IF EXISTS messages_admin_all ON public.messages;
CREATE POLICY messages_participant_select ON public.messages
  FOR SELECT USING (
    public.is_admin() OR EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = messages.conversation_id
        AND cp.user_id = auth.uid()
        AND cp.left_at IS NULL
    )
  );
CREATE POLICY messages_self_insert ON public.messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants cp
      WHERE cp.conversation_id = messages.conversation_id
        AND cp.user_id = auth.uid()
        AND cp.left_at IS NULL
    )
  );
CREATE POLICY messages_admin_all ON public.messages
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- =============================================================================
-- SECDEF RPCs
-- Mirrors the request_cancel_subscription pattern: SECURITY DEFINER, locked
-- search_path, role guards, structured returns, REVOKE/GRANT at the bottom.
-- =============================================================================

-- Short helper for generating PKs that match the project's existing convention
-- (clients: 'C-XX', notifications: 'NT-...'). Local to this migration. We
-- intentionally use md5(random()::text || clock_timestamp()::text) rather
-- than gen_random_bytes — the latter lives in pgcrypto under the extensions
-- schema in Supabase, which doesn't resolve under SECDEF's locked search_path.
CREATE OR REPLACE FUNCTION public._comms_gen_id(p_prefix text)
RETURNS text LANGUAGE sql VOLATILE
SET search_path = public, pg_temp AS $$
  SELECT p_prefix || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
$$;

-- ---- open_conversation: driver↔mechanic 1:1 (or any caller↔counterparty) ----
CREATE OR REPLACE FUNCTION public.open_conversation(
  p_topic text,
  p_topic_ref_id text,
  p_subject text,
  p_counterparty_id uuid
)
RETURNS public.conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_counterparty_role text;
  v_conv public.conversations;
  v_conv_id text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'open_conversation requires an authenticated caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_counterparty_id IS NULL OR p_counterparty_id = v_caller THEN
    RAISE EXCEPTION 'counterparty must be a different user'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_subject IS NULL OR length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'subject is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_topic NOT IN ('general','job','vehicle','maintenance') THEN
    RAISE EXCEPTION 'invalid topic'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT role::text INTO v_caller_role FROM public.profiles WHERE id = v_caller;
  SELECT role::text INTO v_counterparty_role FROM public.profiles WHERE id = p_counterparty_id;

  IF v_counterparty_role IS NULL THEN
    RAISE EXCEPTION 'counterparty profile not found'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_conv_id := public._comms_gen_id('CV');

  INSERT INTO public.conversations (id, topic, topic_ref_id, subject, created_by)
  VALUES (v_conv_id, p_topic, NULLIF(trim(p_topic_ref_id), ''), trim(p_subject), v_caller)
  RETURNING * INTO v_conv;

  -- Insert participants. Caller is 'originator' for traceability; counterparty
  -- takes their natural role (driver / mechanic / admin).
  INSERT INTO public.conversation_participants
    (id, conversation_id, user_id, participant_role)
  VALUES
    (public._comms_gen_id('CP'), v_conv_id, v_caller,
       CASE WHEN v_caller_role IN ('driver','mechanic','admin') THEN 'originator' ELSE 'originator' END),
    (public._comms_gen_id('CP'), v_conv_id, p_counterparty_id, v_counterparty_role);

  RETURN v_conv;
END $$;

-- ---- open_conversation_with_participants: admin-flexible variant ----
CREATE OR REPLACE FUNCTION public.open_conversation_with_participants(
  p_topic text,
  p_topic_ref_id text,
  p_subject text,
  p_participant_ids uuid[]
)
RETURNS public.conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_conv public.conversations;
  v_conv_id text;
  v_pid uuid;
  v_pid_role text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Admin-only variant: only admins can pre-populate an arbitrary participant
  -- list. Drivers/mechanics must use open_conversation() (1:1).
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required for this variant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_subject IS NULL OR length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'subject is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_participant_ids IS NULL OR array_length(p_participant_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'at least one participant required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_conv_id := public._comms_gen_id('CV');

  INSERT INTO public.conversations (id, topic, topic_ref_id, subject, created_by)
  VALUES (v_conv_id, p_topic, NULLIF(trim(p_topic_ref_id), ''), trim(p_subject), v_caller)
  RETURNING * INTO v_conv;

  -- Caller (admin) joins as originator.
  INSERT INTO public.conversation_participants (id, conversation_id, user_id, participant_role)
  VALUES (public._comms_gen_id('CP'), v_conv_id, v_caller, 'originator');

  -- Dedupe + skip caller.
  FOREACH v_pid IN ARRAY ARRAY(SELECT DISTINCT unnest(p_participant_ids))
  LOOP
    IF v_pid = v_caller THEN CONTINUE; END IF;
    SELECT role::text INTO v_pid_role FROM public.profiles WHERE id = v_pid;
    IF v_pid_role IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.conversation_participants (id, conversation_id, user_id, participant_role)
    VALUES (public._comms_gen_id('CP'), v_conv_id, v_pid, v_pid_role)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END LOOP;

  RETURN v_conv;
END $$;

-- ---- tag_admins: caller must be a participant. Adds admins + notifies. ----
CREATE OR REPLACE FUNCTION public.tag_admins(
  p_conversation_id text,
  p_admin_ids uuid[] DEFAULT NULL
)
RETURNS SETOF public.conversation_participants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_name text;
  v_subject text;
  v_admin_id uuid;
  v_inserted_cp public.conversation_participants;
  v_admin_ids uuid[];
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Caller must be an active participant OR an admin.
  IF NOT public.is_admin() AND NOT EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id
      AND user_id = v_caller
      AND left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'caller is not a participant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT name INTO v_caller_name FROM public.profiles WHERE id = v_caller;
  SELECT subject INTO v_subject FROM public.conversations WHERE id = p_conversation_id;
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'conversation not found'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Resolve admin id set. NULL means "all active admins".
  IF p_admin_ids IS NULL OR array_length(p_admin_ids, 1) IS NULL THEN
    SELECT array_agg(id) INTO v_admin_ids
    FROM public.profiles
    WHERE role = 'admin' AND status = 'active';
  ELSE
    -- Filter to actual admins only (no privilege escalation by tagging a driver).
    SELECT array_agg(p.id) INTO v_admin_ids
    FROM public.profiles p
    WHERE p.id = ANY(p_admin_ids) AND p.role = 'admin';
  END IF;

  IF v_admin_ids IS NULL OR array_length(v_admin_ids, 1) IS NULL THEN
    RETURN; -- no admins to tag
  END IF;

  FOREACH v_admin_id IN ARRAY v_admin_ids
  LOOP
    -- Try insert; on conflict (already a participant), reactivate left_at.
    INSERT INTO public.conversation_participants
      (id, conversation_id, user_id, participant_role)
    VALUES
      (public._comms_gen_id('CP'), p_conversation_id, v_admin_id, 'admin')
    ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET left_at = NULL,
          joined_at = COALESCE(public.conversation_participants.joined_at, now())
    RETURNING * INTO v_inserted_cp;

    -- Drop a notification on the tagged admin so their bell badge increments.
    -- 'message' enum value is added in a later migration; use 'system' until then.
    INSERT INTO public.notifications (id, user_id, type, body, link, created_at)
    VALUES (
      'NT-' || substr(md5(v_admin_id::text || clock_timestamp()::text), 1, 10),
      v_admin_id,
      'system'::notification_type,
      'You were tagged by ' || COALESCE(v_caller_name, 'a teammate') || ' in: ' || v_subject,
      '/admin/communications?conv=' || p_conversation_id,
      now()
    );

    RETURN NEXT v_inserted_cp;
  END LOOP;
END $$;

-- ---- join_conversation: admin self-joins an observed thread. ----
CREATE OR REPLACE FUNCTION public.join_conversation(p_conversation_id text)
RETURNS public.conversation_participants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_caller_name text;
  v_cp public.conversation_participants;
  v_other_participant record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id) THEN
    RAISE EXCEPTION 'conversation not found'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT name INTO v_caller_name FROM public.profiles WHERE id = v_caller;

  INSERT INTO public.conversation_participants
    (id, conversation_id, user_id, participant_role)
  VALUES
    (public._comms_gen_id('CP'), p_conversation_id, v_caller, 'admin')
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET left_at = NULL
  RETURNING * INTO v_cp;

  -- Notify every other active participant that admin joined.
  FOR v_other_participant IN
    SELECT user_id FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id
      AND user_id <> v_caller
      AND left_at IS NULL
  LOOP
    INSERT INTO public.notifications (id, user_id, type, body, link, created_at)
    VALUES (
      'NT-' || substr(md5(v_other_participant.user_id::text || clock_timestamp()::text), 1, 10),
      v_other_participant.user_id,
      'system'::notification_type,
      'Admin ' || COALESCE(v_caller_name, '') || ' joined the conversation',
      '/' || (SELECT role::text FROM public.profiles WHERE id = v_other_participant.user_id) ||
        CASE
          WHEN (SELECT role::text FROM public.profiles WHERE id = v_other_participant.user_id) = 'admin'
            THEN '/communications?conv=' || p_conversation_id
          ELSE '/messages?conv=' || p_conversation_id
        END,
      now()
    );
  END LOOP;

  RETURN v_cp;
END $$;

-- ---- leave_conversation: caller leaves; admin keeps RLS read via is_admin(). ----
CREATE OR REPLACE FUNCTION public.leave_conversation(p_conversation_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.conversation_participants
  SET left_at = now()
  WHERE conversation_id = p_conversation_id
    AND user_id = v_caller
    AND left_at IS NULL;
END $$;

-- ---- mark_conversation_read ----
CREATE OR REPLACE FUNCTION public.mark_conversation_read(p_conversation_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.conversation_participants
  SET last_read_at = now()
  WHERE conversation_id = p_conversation_id
    AND user_id = v_caller;
END $$;

-- ---- close_conversation: admin OR originator only ----
CREATE OR REPLACE FUNCTION public.close_conversation(
  p_conversation_id text,
  p_resolution_notes text
)
RETURNS public.conversations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_creator uuid;
  v_conv public.conversations;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT created_by INTO v_creator FROM public.conversations WHERE id = p_conversation_id;
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'conversation not found'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.is_admin() AND v_creator <> v_caller THEN
    RAISE EXCEPTION 'only admin or originator can close'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.conversations
  SET status = 'closed',
      closed_at = now(),
      closed_by = v_caller,
      resolution_notes = NULLIF(trim(p_resolution_notes), '')
  WHERE id = p_conversation_id
  RETURNING * INTO v_conv;

  RETURN v_conv;
END $$;

-- ---- Lock down all the RPCs ----
REVOKE ALL ON FUNCTION public.open_conversation(text, text, text, uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.open_conversation_with_participants(text, text, text, uuid[]) FROM public, anon;
REVOKE ALL ON FUNCTION public.tag_admins(text, uuid[]) FROM public, anon;
REVOKE ALL ON FUNCTION public.join_conversation(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.leave_conversation(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.mark_conversation_read(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.close_conversation(text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public._comms_gen_id(text) FROM public, anon;

GRANT EXECUTE ON FUNCTION public.open_conversation(text, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.open_conversation_with_participants(text, text, text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tag_admins(text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.join_conversation(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.leave_conversation(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_conversation(text, text) TO authenticated, service_role;

-- =============================================================================
-- message-attachments Storage bucket
-- =============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'message-attachments',
  'message-attachments',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Drop-then-create the policies so this migration is idempotent.
DROP POLICY IF EXISTS message_attachments_admin_all ON storage.objects;
DROP POLICY IF EXISTS message_attachments_owner_select ON storage.objects;
DROP POLICY IF EXISTS message_attachments_owner_insert ON storage.objects;

CREATE POLICY message_attachments_admin_all ON storage.objects
  FOR ALL USING (bucket_id = 'message-attachments' AND public.is_admin())
  WITH CHECK (bucket_id = 'message-attachments' AND public.is_admin());
CREATE POLICY message_attachments_owner_select ON storage.objects
  FOR SELECT USING (bucket_id = 'message-attachments' AND owner = auth.uid());
CREATE POLICY message_attachments_owner_insert ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'message-attachments'
    AND owner = auth.uid()
    AND auth.uid() IS NOT NULL
  );
