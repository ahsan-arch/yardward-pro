// twilio-send-message — outbound message dispatcher for the Communications
// feature. Called by api.sendMessage from the SPA. Auth-gated to active
// participants of the target conversation. Lazy-creates the Twilio
// Conversation + per-participant bindings on first send, then POSTs the
// message to Twilio Conversations API. Mirrors the result to public.messages
// so the local DB (read by RLS-scoped queries + realtime channels) stays
// authoritative for queries.
//
// Body: { conversationId: string, body: string, mediaPaths?: string[], idempotencyKey?: string }
// Phase 2 = text-only. mediaPaths is accepted but ignored (MMS lands in Phase 3
// with the twilio-conversations-webhook for inbound). The local row still
// stores mediaPaths so the in-app render works; Twilio just gets the text.
//
// Auth model:
//   - Caller passes their session JWT in Authorization header.
//   - We validate via auth.getUser() then enforce: caller must be an active
//     participant of conversationId. The same predicate the RLS messages_
//     self_insert policy enforces — we just check it explicitly so we can
//     return a clean 403 instead of a silent insert failure.
//
// Twilio identity scheme:
//   - In-app participants (admin or anyone signed into the SPA): Identity =
//     "profile:<uuid>". Stable across role changes.
//   - SMS-only participants (drivers/mechanics on phones): MessagingBinding
//     Address = E.164 phone, ProxyAddress = TWILIO_FROM_NUMBER. Twilio sends
//     them an actual SMS for every message in the conversation.
//
// All errors return structured { error: string, ... } at the appropriate
// HTTP status. Twilio errors are surfaced verbatim so the operator can
// triage misconfigurations from the toast.

interface SendInput {
  conversationId?: string;
  body?: string;
  mediaPaths?: string[];
  idempotencyKey?: string;
}

interface TwilioConversation {
  sid: string;
  friendly_name: string | null;
}
interface TwilioParticipant {
  sid: string;
  identity: string | null;
  messaging_binding: { address?: string; proxy_address?: string } | null;
}
interface TwilioMessage {
  sid: string;
  body: string;
  date_created: string;
}

function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Form-encode an object for the Twilio API (Twilio expects
// application/x-www-form-urlencoded for every endpoint).
function formEncode(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

async function twilioFetch<T>(
  url: string,
  basicAuth: string,
  init?: { method?: string; bodyParams?: Record<string, string | undefined> },
): Promise<{ ok: boolean; status: number; body: T | null; raw: string }> {
  try {
    const resp = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: init?.bodyParams ? formEncode(init.bodyParams) : undefined,
    });
    const raw = await resp.text();
    let body: T | null = null;
    try {
      body = JSON.parse(raw) as T;
    } catch {
      body = null;
    }
    return { ok: resp.ok, status: resp.status, body, raw };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  // ---- Env
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const TWILIO_API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID") ?? "";
  const TWILIO_API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET") ?? "";
  const TWILIO_CONVERSATIONS_SERVICE_SID =
    Deno.env.get("TWILIO_CONVERSATIONS_SERVICE_SID") ?? "";
  const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !TWILIO_API_KEY_SID ||
    !TWILIO_API_KEY_SECRET ||
    !TWILIO_CONVERSATIONS_SERVICE_SID ||
    !TWILIO_FROM_NUMBER
  ) {
    return new Response(
      JSON.stringify({
        error: "missing one of: SUPABASE_*, TWILIO_API_KEY_*, TWILIO_CONVERSATIONS_SERVICE_SID, TWILIO_FROM_NUMBER",
      }),
      { status: 500, headers: corsHeaders },
    );
  }

  // ---- Auth: who is the caller?
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing bearer token" }), {
      status: 401,
      headers: corsHeaders,
    });
  }
  const isServiceRole = eqConstTime(bearer, SUPABASE_SERVICE_ROLE_KEY);
  let callerId = "";
  if (isServiceRole) {
    // Service-role can't be a participant — disallow. The send-as-system
    // path will be added in Phase 3 (inbound webhook can post system messages).
    return new Response(
      JSON.stringify({ error: "service-role cannot send conversation messages directly" }),
      { status: 403, headers: corsHeaders },
    );
  } else {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${bearer}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!userResp.ok) {
      return new Response(JSON.stringify({ error: "invalid token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const userData = await userResp.json();
    callerId = userData?.id ?? "";
    if (!callerId) {
      return new Response(JSON.stringify({ error: "no user id in token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
  }

  // ---- Body
  let input: SendInput;
  try {
    input = (await req.json()) as SendInput;
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  const conversationId = input.conversationId?.trim() ?? "";
  const bodyText = (input.body ?? "").toString();
  const mediaPaths = Array.isArray(input.mediaPaths) ? input.mediaPaths : [];
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (!conversationId) {
    return new Response(JSON.stringify({ error: "conversationId required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (!bodyText.trim() && mediaPaths.length === 0) {
    return new Response(JSON.stringify({ error: "body or mediaPaths required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (bodyText.length > 1600) {
    return new Response(JSON.stringify({ error: "body must be 1600 chars or fewer" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // ---- Caller must be an active participant
  // Use service-role headers for DB calls so we can read everything we need
  // without bumping into RLS — we re-enforce the participant check ourselves.
  const sbHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  } as const;

  const callerCpResp = await fetch(
    `${SUPABASE_URL}/rest/v1/conversation_participants?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${callerId}&left_at=is.null&select=id`,
    { headers: sbHeaders },
  );
  const callerCpRows = (await callerCpResp.json()) as Array<{ id: string }>;
  if (!Array.isArray(callerCpRows) || callerCpRows.length === 0) {
    return new Response(
      JSON.stringify({
        error:
          "caller is not an active participant of this conversation. Tag them, or admin must join_conversation first.",
      }),
      { status: 403, headers: corsHeaders },
    );
  }

  // ---- Load conversation + all active participants
  type ConvRow = { id: string; twilio_conversation_sid: string | null; subject: string };
  const convResp = await fetch(
    `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(conversationId)}&select=id,twilio_conversation_sid,subject`,
    { headers: sbHeaders },
  );
  const convRows = (await convResp.json()) as ConvRow[];
  if (!Array.isArray(convRows) || convRows.length === 0) {
    return new Response(JSON.stringify({ error: "conversation not found" }), {
      status: 404,
      headers: corsHeaders,
    });
  }
  const conv = convRows[0];

  type CpRow = {
    id: string;
    user_id: string;
    twilio_participant_sid: string | null;
    participant_role: string;
  };
  const cpResp = await fetch(
    `${SUPABASE_URL}/rest/v1/conversation_participants?conversation_id=eq.${encodeURIComponent(conversationId)}&left_at=is.null&select=id,user_id,twilio_participant_sid,participant_role`,
    { headers: sbHeaders },
  );
  const cps = (await cpResp.json()) as CpRow[];

  // Pull phones for SMS participants (any participant who's not the caller
  // gets a messaging binding by default. We use the in-app identity for the
  // CALLER so their reply goes out via the app, not as an SMS-from-self.)
  const otherIds = cps.map((c) => c.user_id);
  type ProfileRow = { id: string; phone: string | null; role: string };
  const profResp = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=in.(${otherIds.map(encodeURIComponent).join(",")})&select=id,phone,role`,
    { headers: sbHeaders },
  );
  const profileRows = (await profResp.json()) as ProfileRow[];
  const profileById = new Map<string, ProfileRow>();
  for (const p of profileRows) profileById.set(p.id, p);

  const basicAuth = btoa(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`);
  const twilioBase = `https://conversations.twilio.com/v1/Services/${TWILIO_CONVERSATIONS_SERVICE_SID}`;

  // ---- Lazy-create Twilio Conversation
  let twilioConvSid = conv.twilio_conversation_sid;
  if (!twilioConvSid) {
    const create = await twilioFetch<TwilioConversation>(
      `${twilioBase}/Conversations`,
      basicAuth,
      {
        method: "POST",
        bodyParams: {
          FriendlyName: conv.subject.slice(0, 256),
          UniqueName: conv.id, // idempotent — second create attempt 409s
        },
      },
    );
    if (!create.ok || !create.body) {
      // Try to fetch by UniqueName in case a previous attempt half-created it.
      const lookup = await twilioFetch<TwilioConversation>(
        `${twilioBase}/Conversations/${encodeURIComponent(conv.id)}`,
        basicAuth,
      );
      if (lookup.ok && lookup.body) {
        twilioConvSid = lookup.body.sid;
      } else {
        return new Response(
          JSON.stringify({
            error: `Twilio conversation create failed: HTTP ${create.status} — ${create.raw.slice(0, 300)}`,
          }),
          { status: 502, headers: corsHeaders },
        );
      }
    } else {
      twilioConvSid = create.body.sid;
    }
    // Persist the SID so subsequent sends skip the lazy-create.
    await fetch(
      `${SUPABASE_URL}/rest/v1/conversations?id=eq.${encodeURIComponent(conv.id)}`,
      {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify({ twilio_conversation_sid: twilioConvSid }),
      },
    );
  }

  // ---- Lazy-add each participant on Twilio side
  for (const cp of cps) {
    if (cp.twilio_participant_sid) continue;
    const prof = profileById.get(cp.user_id);
    // SMS binding for drivers/mechanics with a real phone; otherwise in-app
    // identity. Admin always goes in via identity.
    const isE164 = !!prof?.phone && /^\+[1-9]\d{9,14}$/.test(prof.phone);
    const useSmsBinding =
      isE164 && (cp.participant_role === "driver" || cp.participant_role === "mechanic");

    const params: Record<string, string | undefined> = useSmsBinding
      ? {
          "MessagingBinding.Address": prof!.phone!,
          "MessagingBinding.ProxyAddress": TWILIO_FROM_NUMBER,
        }
      : { Identity: `profile:${cp.user_id}` };

    const addResp = await twilioFetch<TwilioParticipant>(
      `${twilioBase}/Conversations/${twilioConvSid}/Participants`,
      basicAuth,
      { method: "POST", bodyParams: params },
    );
    if (addResp.ok && addResp.body) {
      await fetch(
        `${SUPABASE_URL}/rest/v1/conversation_participants?id=eq.${encodeURIComponent(cp.id)}`,
        {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ twilio_participant_sid: addResp.body.sid }),
        },
      );
    } else if (addResp.status === 409) {
      // Conflict — already bound. Look it up so we can persist the existing SID.
      const list = await twilioFetch<{ participants: TwilioParticipant[] }>(
        `${twilioBase}/Conversations/${twilioConvSid}/Participants`,
        basicAuth,
      );
      if (list.ok && list.body) {
        const match = list.body.participants?.find((p) => {
          if (useSmsBinding) return p.messaging_binding?.address === prof?.phone;
          return p.identity === `profile:${cp.user_id}`;
        });
        if (match) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/conversation_participants?id=eq.${encodeURIComponent(cp.id)}`,
            {
              method: "PATCH",
              headers: sbHeaders,
              body: JSON.stringify({ twilio_participant_sid: match.sid }),
            },
          );
        }
      }
    } else if (!useSmsBinding && cp.user_id === callerId) {
      // Caller must be bound or the message POST will fail.
      return new Response(
        JSON.stringify({
          error: `Failed to bind caller as Twilio participant: HTTP ${addResp.status} — ${addResp.raw.slice(0, 300)}`,
        }),
        { status: 502, headers: corsHeaders },
      );
    }
    // For non-caller binding failures we soft-fail — the message still flows;
    // that participant just won't receive notifications via Twilio (they
    // still see it in-app via Supabase realtime).
  }

  // ---- Outbound MMS: upload each Storage path to Twilio Media Content Service
  // Twilio expects either a public URL or pre-uploaded MediaSid(s) in the
  // message body. We mint a 1h signed URL for each Storage path and POST it
  // to MCS, which returns a MediaSid we attach to the Conversations message.
  const mediaSids: string[] = [];
  for (const path of mediaPaths) {
    // Mint signed URL via Storage REST endpoint.
    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/message-attachments/${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!signResp.ok) {
      // Soft-fail this attachment, continue with text. Operator will see
      // a partial-failure in error_log if they wire it.
      continue;
    }
    const signed = (await signResp.json()) as { signedURL?: string; signedUrl?: string };
    const relUrl = signed.signedURL ?? signed.signedUrl ?? "";
    if (!relUrl) continue;
    const fullSignedUrl = relUrl.startsWith("http")
      ? relUrl
      : `${SUPABASE_URL}/storage/v1${relUrl}`;

    // POST to Twilio MCS. Conversations Media is at the global MCS endpoint
    // scoped to the Conversations Service.
    const mcsResp = await fetch(
      `https://mcs.us1.twilio.com/v1/Services/${TWILIO_CONVERSATIONS_SERVICE_SID}/Media`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/octet-stream",
        },
        // Twilio's "create from URL" doesn't exist for MCS — we must stream
        // the bytes through. Fetch the signed URL, pipe to MCS.
        body: await (await fetch(fullSignedUrl)).arrayBuffer(),
      },
    );
    if (!mcsResp.ok) continue;
    const mcsBody = (await mcsResp.json()) as { sid?: string };
    if (mcsBody.sid) mediaSids.push(mcsBody.sid);
  }

  // ---- POST the message to Twilio
  const msgBodyParams: Record<string, string | undefined> = {
    Author: `profile:${callerId}`,
    Body: bodyText,
  };
  // MediaSid is repeatable — Twilio accepts MediaSid=IS... multiple times.
  // formEncode flattens a single value; we use a manual builder below.
  let messageBody = "";
  for (const [k, v] of Object.entries(msgBodyParams)) {
    if (v === undefined || v === "") continue;
    messageBody += `${encodeURIComponent(k)}=${encodeURIComponent(v)}&`;
  }
  for (const sid of mediaSids) {
    messageBody += `MediaSid=${encodeURIComponent(sid)}&`;
  }
  if (messageBody.endsWith("&")) messageBody = messageBody.slice(0, -1);

  const msgPost = await (async () => {
    try {
      const resp = await fetch(
        `${twilioBase}/Conversations/${twilioConvSid}/Messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: messageBody,
        },
      );
      const raw = await resp.text();
      let body: TwilioMessage | null = null;
      try {
        body = JSON.parse(raw) as TwilioMessage;
      } catch {
        body = null;
      }
      return { ok: resp.ok, status: resp.status, body, raw };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: null as TwilioMessage | null,
        raw: err instanceof Error ? err.message : String(err),
      };
    }
  })();
  if (!msgPost.ok || !msgPost.body) {
    return new Response(
      JSON.stringify({
        error: `Twilio message POST failed: HTTP ${msgPost.status} — ${msgPost.raw.slice(0, 300)}`,
      }),
      { status: 502, headers: corsHeaders },
    );
  }
  const twilioMessageSid = msgPost.body.sid;

  // ---- Mirror to public.messages — idempotent on (sender_id, idempotency_key)
  const localId =
    "MSG-" + crypto.getRandomValues(new Uint8Array(5)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({
      id: localId,
      conversation_id: conversationId,
      twilio_message_sid: twilioMessageSid,
      idempotency_key: idempotencyKey,
      sender_id: callerId,
      sender_kind: "in_app",
      body: bodyText,
      media_paths: mediaPaths,
      delivery_status: "sent",
      delivered_at: new Date().toISOString(),
    }),
  });
  if (!insertResp.ok) {
    const raw = await insertResp.text();
    return new Response(
      JSON.stringify({
        error: `Local mirror insert failed: HTTP ${insertResp.status} — ${raw.slice(0, 300)}`,
        twilioMessageSid,
      }),
      { status: 500, headers: corsHeaders },
    );
  }
  const inserted = (await insertResp.json()) as Array<Record<string, unknown>>;
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  return new Response(JSON.stringify({ message: row }), {
    status: 200,
    headers: corsHeaders,
  });
});
