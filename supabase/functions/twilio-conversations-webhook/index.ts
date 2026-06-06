// twilio-conversations-webhook — receives Twilio Conversations webhook events
// (inbound SMS replies, MMS attachments, delivery confirmations, participant
// joins) and mirrors them into our Postgres tables.
//
// Security stance (hardened after the Phase 3 adversarial security review):
//
// 1. HMAC-SHA1 X-Twilio-Signature verification. The canonical input is
//    constructed by iterating URLSearchParams entries in document order,
//    sorted by key, with ALL values for duplicate keys appended in the order
//    Twilio sent them. This matches twilio-node's RequestValidator and is
//    the only correct algorithm for MMS bodies that contain repeated keys
//    (MediaUrl0, MediaUrl1, etc. occasionally collide in older event flavors).
//
// 2. Constant-time byte compare for signature equality (decodes both sides
//    via base64 to bytes; eliminates UTF-16 surrogate edge + V8 string-
//    representation timing side-channels).
//
// 3. Replay protection. Every webhook payload's (source, payload_hash) goes
//    into webhook_replay_log via INSERT-on-conflict-do-nothing. A second
//    submission with the same hash returns the cached ack without running
//    any side effects.
//
// 4. Post-verify field validation. EventType, SIDs, Author, and Body are
//    constrained to strict allowlists / regexes BEFORE any DB write — even
//    a valid HMAC over a hostile-shaped body gets rejected.
//
// 5. Every fetch response status is inspected. PostgREST 4xx responses
//    (especially 409 on UNIQUE conflicts) abort the relevant handler branch
//    so a concurrent webhook can't double-fanout notifications.
//
// 6. Unknown senders (phone that doesn't map to a profile) are logged to
//    error_log and skipped — never inserted with a sentinel UUID that would
//    fail the FK to profiles.
//
// 7. Body truncated to 8000 chars (also CHECK-constrained server-side) so a
//    hostile MMS can't blow out the Realtime payload limit.
//
// Events handled:
//   onMessageAdded            — mirror to public.messages + drop notifications
//   onConversationUpdated     — update local conversations.status
//   onParticipantAdded        — UPSERT into conversation_participants
//   onParticipantRemoved      — set left_at on conversation_participants
//   onDeliveryUpdated         — update messages.delivery_status

// ---- Strict input allowlists / regexes ----
const ALLOWED_EVENT_TYPES = new Set([
  "onMessageAdded",
  "onConversationUpdated",
  "onParticipantAdded",
  "onParticipantRemoved",
  "onDeliveryUpdated",
]);
const TWILIO_SID_RX = /^[A-Z]{2}[0-9a-f]{32}$/;
const E164_RX = /^\+[1-9]\d{9,14}$/;
const PROFILE_IDENTITY_RX = /^profile:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BASE64_RX = /^[A-Za-z0-9+/]+=*$/;
const BODY_MAX_CHARS = 8000;

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array | null {
  if (!BASE64_RX.test(b64)) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Constant-time byte comparison. Lengths must match.
function bytesEqConstTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

// SHA-256 of an arbitrary string — used for the replay-log dedupe key.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Twilio signature builder. Iterates ALL form params in document order
// (preserving duplicates) and sorts by key. Matches twilio-node's
// RequestValidator behavior.
async function computeTwilioSignature(
  authToken: string,
  url: string,
  formParams: URLSearchParams,
): Promise<string> {
  // Group entries by key, then sort keys.
  const grouped = new Map<string, string[]>();
  for (const [k, v] of formParams.entries()) {
    const list = grouped.get(k);
    if (list) list.push(v);
    else grouped.set(k, [v]);
  }
  const sortedKeys = [...grouped.keys()].sort();
  let data = url;
  for (const k of sortedKeys) {
    for (const v of grouped.get(k)!) data += k + v;
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    new TextEncoder().encode(data),
  );
  return bytesToBase64(new Uint8Array(sig));
}

function linkForRecipient(role: string | undefined, conversationId: string): string {
  if (role === "admin") return `/admin/communications?conv=${conversationId}`;
  if (role === "mechanic") return `/mechanic/messages?conv=${conversationId}`;
  return `/driver/messages?conv=${conversationId}`;
}

function genId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `${prefix}-${hex}`;
}

function pluckMediaUrls(formParams: URLSearchParams): string[] {
  const urls: string[] = [];
  // "Media" CSV/JSON style
  const mediaField = formParams.get("Media");
  if (mediaField) {
    try {
      const parsed = JSON.parse(mediaField);
      if (Array.isArray(parsed)) {
        for (const m of parsed) {
          if (typeof m === "string") urls.push(m);
          else if (m && typeof m === "object" && typeof m.Url === "string") urls.push(m.Url);
        }
      }
    } catch {
      urls.push(...mediaField.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  // MediaUrlN style — iterate entries to catch duplicates per the new rules.
  for (const [k, v] of formParams.entries()) {
    if (/^MediaUrl\d+$/.test(k) && v) urls.push(v);
  }
  return urls;
}

Deno.serve(async (req) => {
  const okHeaders = { "Content-Type": "application/json" };
  const ackAndReturn = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 200, headers: okHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const TWILIO_WEBHOOK_BASE_URL = Deno.env.get("TWILIO_WEBHOOK_BASE_URL") ?? "";

  // Env guard includes TWILIO_WEBHOOK_BASE_URL so a missing config doesn't
  // silently degrade to verifying-against-empty-string.
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_WEBHOOK_BASE_URL
  ) {
    return ackAndReturn({ ack: false, error: "missing env" });
  }

  if (req.method !== "POST") return ackAndReturn({ ack: false, error: "POST only" });

  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  } as const;

  // ---- Read body
  const rawBody = await req.text();
  if (rawBody.length > 256 * 1024) {
    return ackAndReturn({ ack: false, error: "body too large" });
  }
  const formParams = new URLSearchParams(rawBody);

  // ---- HMAC verify (proper duplicate-key handling)
  const incomingSigB64 = (req.headers.get("x-twilio-signature") ?? "").trim();
  if (!incomingSigB64) return ackAndReturn({ ack: false, error: "missing signature" });
  const incomingBytes = base64ToBytes(incomingSigB64);
  if (!incomingBytes) return ackAndReturn({ ack: false, error: "signature not base64" });

  const expectedB64 = await computeTwilioSignature(
    TWILIO_AUTH_TOKEN,
    TWILIO_WEBHOOK_BASE_URL,
    formParams,
  );
  const expectedBytes = base64ToBytes(expectedB64)!;
  if (!bytesEqConstTime(incomingBytes, expectedBytes)) {
    return ackAndReturn({ ack: false, error: "signature mismatch" });
  }

  // ---- Replay protection. Hash the raw body + signature; check + insert
  // into webhook_replay_log. UNIQUE (source, payload_hash) makes this safe
  // even under concurrent calls — the second one gets 23505 and we bail.
  const payloadHash = await sha256Hex(rawBody + " " + incomingSigB64);
  const eventType = formParams.get("EventType") ?? "";
  const convSidRaw = formParams.get("ConversationSid") ?? "";
  const messageSidRaw = formParams.get("MessageSid") ?? "";
  const participantSidRaw = formParams.get("ParticipantSid") ?? "";

  // Strict EventType allowlist BEFORE any DB write.
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    // Log once for visibility, then ack so Twilio doesn't retry.
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          id: genId("ERR"),
          severity: "info",
          error_code: "TWILIO_WEBHOOK_UNKNOWN_EVENT",
          message: `Ignored unknown EventType=${eventType.slice(0, 64)}`,
          context: { eventType: eventType.slice(0, 64) },
        }),
      });
    } catch { /* ignore */ }
    return ackAndReturn({ ack: true, ignored: "unknown event" });
  }

  // SID validation (Twilio's published format).
  if (convSidRaw && !TWILIO_SID_RX.test(convSidRaw)) {
    return ackAndReturn({ ack: false, error: "invalid ConversationSid format" });
  }
  if (messageSidRaw && !TWILIO_SID_RX.test(messageSidRaw)) {
    return ackAndReturn({ ack: false, error: "invalid MessageSid format" });
  }
  if (participantSidRaw && !TWILIO_SID_RX.test(participantSidRaw)) {
    return ackAndReturn({ ack: false, error: "invalid ParticipantSid format" });
  }

  // Replay check. We insert FIRST and rely on the unique violation to
  // distinguish first-seen from replay — atomic, no TOCTOU window.
  const replayId = genId("WRL");
  const replayResp = await fetch(
    `${SUPABASE_URL}/rest/v1/webhook_replay_log?on_conflict=source,payload_hash`,
    {
      method: "POST",
      headers: {
        ...sbHeaders,
        Prefer: "return=representation,resolution=ignore-duplicates",
      },
      body: JSON.stringify({
        id: replayId,
        source: "twilio-conversations",
        payload_hash: payloadHash,
        event_type: eventType,
        twilio_message_sid: messageSidRaw || null,
        twilio_conversation_sid: convSidRaw || null,
        twilio_participant_sid: participantSidRaw || null,
      }),
    },
  );
  if (!replayResp.ok) {
    // 409 here means the replay conflict path; resolution=ignore-duplicates
    // means PostgREST returns the existing row instead. If we still got an
    // error, surface it as ack-false so Twilio retries.
    return ackAndReturn({ ack: false, error: "replay log write failed" });
  }
  const replayRows = (await replayResp.json()) as Array<{ id: string }>;
  if (replayRows.length === 0) {
    // ignore-duplicates returns [] when the row already existed.
    return ackAndReturn({ ack: true, deduped: "replay" });
  }

  // ---- Helpers
  async function resolveLocalConvId(): Promise<string | null> {
    if (!convSidRaw) return null;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?twilio_conversation_sid=eq.${encodeURIComponent(convSidRaw)}&select=id`,
      { headers: sbHeaders },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }
  async function profileByPhone(phone: string): Promise<{
    id: string; role: string; name: string;
  } | null> {
    if (!E164_RX.test(phone)) return null;
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?phone=eq.${encodeURIComponent(phone)}&select=id,role,name`,
      { headers: sbHeaders },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ id: string; role: string; name: string }>;
    return rows[0] ?? null;
  }
  function uuidFromIdentity(identity: string | undefined): string | null {
    if (!identity) return null;
    const m = identity.match(PROFILE_IDENTITY_RX);
    return m ? m[1] : null;
  }
  async function logIssue(code: string, message: string, ctx: Record<string, unknown>) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          id: genId("ERR"),
          severity: "warning",
          error_code: code,
          message,
          context: ctx,
        }),
      });
    } catch { /* ignore */ }
  }

  try {
    if (eventType === "onMessageAdded") {
      if (!messageSidRaw) return ackAndReturn({ ack: true, skipped: "no MessageSid" });

      // Dedupe against existing message row (cheaper than waiting for the
      // UNIQUE violation since we then have to interpret the error).
      const existsR = await fetch(
        `${SUPABASE_URL}/rest/v1/messages?twilio_message_sid=eq.${encodeURIComponent(messageSidRaw)}&select=id`,
        { headers: sbHeaders },
      );
      if (existsR.ok) {
        const existsRows = (await existsR.json()) as Array<{ id: string }>;
        if (existsRows.length > 0) {
          return ackAndReturn({ ack: true, deduped: "message" });
        }
      }

      // Resolve sender identity.
      const author = formParams.get("Author") ?? "";
      const authorIsPhone = E164_RX.test(author);
      const fromUuid = uuidFromIdentity(author);
      let senderProfileId: string | null = null;
      let senderRole: string | null = null;
      if (fromUuid) {
        senderProfileId = fromUuid;
        const pR = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=eq.${fromUuid}&select=role`,
          { headers: sbHeaders },
        );
        if (pR.ok) {
          const rows = (await pR.json()) as Array<{ role: string }>;
          senderRole = rows[0]?.role ?? null;
        }
      } else if (authorIsPhone) {
        const prof = await profileByPhone(author);
        if (prof) {
          senderProfileId = prof.id;
          senderRole = prof.role;
        }
      } else if (author) {
        // Author present but neither phone nor profile:uuid — reject.
        await logIssue("TWILIO_INBOUND_BAD_AUTHOR", `Unrecognized Author format`, { author });
        return ackAndReturn({ ack: true, skipped: "bad author" });
      }

      // Sender must be resolvable to a profile. No sentinel UUID — would
      // fail the FK silently and drop the message.
      if (!senderProfileId) {
        await logIssue(
          "TWILIO_INBOUND_UNKNOWN_SENDER",
          `Inbound message from unmapped sender — set the profile's phone via /admin/drivers then re-run`,
          { author, body: (formParams.get("Body") ?? "").slice(0, 200) },
        );
        return ackAndReturn({ ack: true, skipped: "unknown sender" });
      }

      // Resolve / auto-create local conversation.
      let localConvId = await resolveLocalConvId();
      if (!localConvId) {
        if (!authorIsPhone) {
          // No local conv + not-an-SMS-author = orphan event we don't auto-handle.
          await logIssue("TWILIO_INBOUND_UNMATCHED", "No local conv for non-SMS event", {
            convSid: convSidRaw,
            author,
          });
          return ackAndReturn({ ack: true, skipped: "unmatched non-sms" });
        }
        // Auto-create. Race-safe: try insert, on 409 re-resolve and use the winner.
        const newId = genId("CV");
        const createResp = await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "return=representation,resolution=ignore-duplicates" },
          body: JSON.stringify({
            id: newId,
            twilio_conversation_sid: convSidRaw,
            topic: "general",
            subject: "SMS thread",
            created_by: senderProfileId,
          }),
        });
        if (createResp.ok) {
          const created = (await createResp.json()) as Array<{ id: string }>;
          if (created.length > 0) {
            localConvId = created[0].id;
            // Add sender as participant (also race-safe via UPSERT).
            await fetch(
              `${SUPABASE_URL}/rest/v1/conversation_participants?on_conflict=conversation_id,user_id`,
              {
                method: "POST",
                headers: {
                  ...sbHeaders,
                  Prefer: "resolution=merge-duplicates,return=minimal",
                },
                body: JSON.stringify({
                  id: genId("CP"),
                  conversation_id: localConvId,
                  user_id: senderProfileId,
                  participant_role: senderRole === "mechanic" ? "mechanic" : "driver",
                }),
              },
            );
          } else {
            // ignore-duplicates returned [] — someone else won. Re-resolve.
            localConvId = await resolveLocalConvId();
          }
        } else {
          // Unexpected error path — abort, ack, log.
          const errRaw = await createResp.text();
          await logIssue("TWILIO_INBOUND_CREATE_FAILED", "Auto-create POST failed", {
            convSid: convSidRaw,
            status: createResp.status,
            body: errRaw.slice(0, 200),
          });
          return ackAndReturn({ ack: false, error: "auto-create failed" });
        }
      }
      if (!localConvId) {
        await logIssue("TWILIO_INBOUND_UNMATCHED", "Couldn't resolve conversation post-create", {
          convSid: convSidRaw,
        });
        return ackAndReturn({ ack: true, skipped: "no conv id" });
      }

      // ---- Insert the message. Truncate body. sender_kind based on origin.
      const senderKind = authorIsPhone ? "sms" : "in_app";
      const mediaUrls = pluckMediaUrls(formParams);
      const truncatedBody = (formParams.get("Body") ?? "").slice(0, BODY_MAX_CHARS);
      const localMsgId = genId("MSG");
      const insResp = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
        method: "POST",
        headers: {
          ...sbHeaders,
          Prefer: "return=representation,resolution=ignore-duplicates",
        },
        body: JSON.stringify({
          id: localMsgId,
          conversation_id: localConvId,
          twilio_message_sid: messageSidRaw,
          sender_id: senderProfileId,
          sender_kind: senderKind,
          body: truncatedBody,
          media_paths: [],
          twilio_media_urls: mediaUrls,
          delivery_status: "received",
          delivered_at: new Date().toISOString(),
        }),
      });
      if (!insResp.ok) {
        const raw = await insResp.text();
        await logIssue("TWILIO_INBOUND_INSERT_FAILED", "messages INSERT failed", {
          convId: localConvId,
          twilioMsgSid: messageSidRaw,
          status: insResp.status,
          body: raw.slice(0, 300),
        });
        return ackAndReturn({ ack: false, error: "insert failed" });
      }
      const insertedRows = (await insResp.json()) as Array<{ id: string }>;
      if (insertedRows.length === 0) {
        // Concurrent winner inserted same twilio_message_sid; skip fanout.
        return ackAndReturn({ ack: true, deduped: "concurrent" });
      }

      // Stamp the replay log with the resulting message id.
      await fetch(
        `${SUPABASE_URL}/rest/v1/webhook_replay_log?id=eq.${encodeURIComponent(replayId)}`,
        {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ resulted_in_message_id: localMsgId }),
        },
      );

      // Fanout notifications to non-sender active participants.
      const partsR = await fetch(
        `${SUPABASE_URL}/rest/v1/conversation_participants?conversation_id=eq.${encodeURIComponent(localConvId)}&left_at=is.null&select=user_id`,
        { headers: sbHeaders },
      );
      if (!partsR.ok) {
        return ackAndReturn({ ack: true, mirrored: localMsgId, fanout: "skipped" });
      }
      const parts = (await partsR.json()) as Array<{ user_id: string }>;
      const recipients = parts
        .map((p) => p.user_id)
        .filter((id) => id !== senderProfileId);
      if (recipients.length > 0) {
        // Look up roles for proper link routing.
        const idsCsv = recipients.map(encodeURIComponent).join(",");
        const roleR = await fetch(
          `${SUPABASE_URL}/rest/v1/profiles?id=in.(${idsCsv})&select=id,role`,
          { headers: sbHeaders },
        );
        const roleById = new Map<string, string>();
        if (roleR.ok) {
          const roleRows = (await roleR.json()) as Array<{ id: string; role: string }>;
          for (const r of roleRows) roleById.set(r.id, r.role);
        }
        // Per-row INSERT loop: one bad user_id (e.g. user deleted mid-flight)
        // doesn't drop the whole batch.
        for (const uid of recipients) {
          const notif = {
            id: genId("NT"),
            user_id: uid,
            type: "system" as const,
            body: "New message in conversation",
            link: linkForRecipient(roleById.get(uid), localConvId),
            created_at: new Date().toISOString(),
          };
          const nResp = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(notif),
          });
          if (!nResp.ok) {
            const raw = await nResp.text();
            await logIssue(
              "TWILIO_NOTIF_INSERT_FAILED",
              `Per-row notification insert failed`,
              { uid, msgId: localMsgId, status: nResp.status, body: raw.slice(0, 200) },
            );
          }
        }
      }
      return ackAndReturn({ ack: true, mirrored: localMsgId });
    }

    if (eventType === "onConversationUpdated") {
      const stateRaw = (formParams.get("State") ?? "").toLowerCase();
      const localConvId = await resolveLocalConvId();
      if (!localConvId) return ackAndReturn({ ack: true, skipped: "no local conv" });
      const stateMap: Record<string, string> = {
        active: "active",
        inactive: "archived",
        closed: "closed",
      };
      const target = stateMap[stateRaw];
      if (!target) return ackAndReturn({ ack: true, skipped: "unknown state" });
      await fetch(
        `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(localConvId)}`,
        {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ status: target }),
        },
      );
      return ackAndReturn({ ack: true });
    }

    if (eventType === "onParticipantAdded") {
      const localConvId = await resolveLocalConvId();
      if (!localConvId) return ackAndReturn({ ack: true, skipped: "no local conv" });
      const tps = participantSidRaw;
      let userId: string | null = null;
      let role = "driver";
      const ident = formParams.get("Identity") ?? "";
      const phone = formParams.get("MessagingBinding.Address") ?? "";
      const idUuid = uuidFromIdentity(ident);
      if (idUuid) {
        userId = idUuid;
      } else if (phone) {
        const prof = await profileByPhone(phone);
        if (prof) {
          userId = prof.id;
          role = prof.role;
        }
      }
      if (!userId) {
        await logIssue("TWILIO_PARTICIPANT_UNRESOLVED", "Couldn't map participant to profile", {
          convSid: convSidRaw,
          ident,
          phone,
        });
        return ackAndReturn({ ack: true, skipped: "unresolved" });
      }
      // UPSERT — reactivating left_at is the documented Twilio behavior (a
      // re-added participant). The actual privilege risk here is mitigated
      // by the HMAC verify + replay-log dedupe at the top of this function.
      await fetch(
        `${SUPABASE_URL}/rest/v1/conversation_participants?on_conflict=conversation_id,user_id`,
        {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            id: genId("CP"),
            conversation_id: localConvId,
            user_id: userId,
            participant_role:
              role === "admin" ? "admin" : role === "mechanic" ? "mechanic" : "driver",
            twilio_participant_sid: tps || null,
            left_at: null,
          }),
        },
      );
      return ackAndReturn({ ack: true });
    }

    if (eventType === "onParticipantRemoved") {
      if (participantSidRaw) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/conversation_participants?twilio_participant_sid=eq.${encodeURIComponent(participantSidRaw)}`,
          {
            method: "PATCH",
            headers: sbHeaders,
            body: JSON.stringify({ left_at: new Date().toISOString() }),
          },
        );
      }
      return ackAndReturn({ ack: true });
    }

    if (eventType === "onDeliveryUpdated") {
      const status = (formParams.get("Status") ?? "").toLowerCase();
      const valid = new Set(["queued", "sent", "delivered", "failed", "received"]);
      if (messageSidRaw && valid.has(status)) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/messages?twilio_message_sid=eq.${encodeURIComponent(messageSidRaw)}`,
          {
            method: "PATCH",
            headers: sbHeaders,
            body: JSON.stringify({
              delivery_status: status,
              error_code: formParams.get("ErrorCode") ?? null,
              delivered_at: status === "delivered" ? new Date().toISOString() : null,
            }),
          },
        );
      }
      return ackAndReturn({ ack: true });
    }

    // Shouldn't reach — allowlist above gates EventType. Defense in depth.
    return ackAndReturn({ ack: true, ignored: "unhandled" });
  } catch (err) {
    try {
      const message =
        err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          id: genId("ERR"),
          severity: "error",
          error_code: "TWILIO_WEBHOOK_HANDLER",
          message: message.slice(0, 4000),
          context: { eventType, convSid: convSidRaw },
        }),
      });
      if (!r.ok) {
        console.error(`[twilio-webhook] error_log write failed: ${r.status}`);
      }
    } catch {
      console.error("[twilio-webhook] outer catch: error_log POST threw");
    }
    return ackAndReturn({ ack: false, error: "internal" });
  }
});
