// twilio-configure-webhook — one-shot edge function that programmatically
// sets the Twilio Conversations Service webhook URL + filters via the
// Twilio REST API. Saves the operator a manual trip through Twilio Console.
//
// Reads from env (already set):
//   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET
//   TWILIO_CONVERSATIONS_SERVICE_SID
//   TWILIO_WEBHOOK_BASE_URL  (the target post-event URL)
//
// Auth: admin Bearer or service-role. Same gate pattern as twilio-verify.

function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const TWILIO_API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID") ?? "";
  const TWILIO_API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET") ?? "";
  const TWILIO_CONVERSATIONS_SERVICE_SID =
    Deno.env.get("TWILIO_CONVERSATIONS_SERVICE_SID") ?? "";
  const TWILIO_WEBHOOK_BASE_URL = Deno.env.get("TWILIO_WEBHOOK_BASE_URL") ?? "";

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !TWILIO_API_KEY_SID ||
    !TWILIO_API_KEY_SECRET ||
    !TWILIO_CONVERSATIONS_SERVICE_SID ||
    !TWILIO_WEBHOOK_BASE_URL
  ) {
    return new Response(JSON.stringify({ error: "missing env" }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  // Auth gate
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing bearer" }), {
      status: 401,
      headers: corsHeaders,
    });
  }
  const isServiceRole = eqConstTime(bearer, SUPABASE_SERVICE_ROLE_KEY);
  if (!isServiceRole) {
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
    const uid = userData?.id;
    if (!uid || typeof uid !== "string") {
      return new Response(JSON.stringify({ error: "auth/v1/user returned no user id" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    const prof = (await profResp.json()) as Array<{ role: string }>;
    if (!Array.isArray(prof) || prof[0]?.role !== "admin") {
      return new Response(JSON.stringify({ error: "admin required" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
  }

  // Configure the webhooks. POST x-www-form-urlencoded; Twilio accepts
  // Filters as a repeated key.
  const basicAuth = btoa(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`);
  const filters = [
    "onMessageAdded",
    "onConversationUpdated",
    "onParticipantAdded",
    "onParticipantRemoved",
    "onDeliveryUpdated",
  ];
  const body = [
    `PostWebhookUrl=${encodeURIComponent(TWILIO_WEBHOOK_BASE_URL)}`,
    `Method=POST`,
    ...filters.map((f) => `Filters=${encodeURIComponent(f)}`),
  ].join("&");

  const resp = await fetch(
    `https://conversations.twilio.com/v1/Services/${TWILIO_CONVERSATIONS_SERVICE_SID}/Configuration/Webhooks`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
  );
  const raw = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch { /* ignore */ }

  if (!resp.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        twilioStatus: resp.status,
        twilioBody: raw.slice(0, 500),
      }),
      { status: 200, headers: corsHeaders },
    );
  }
  return new Response(
    JSON.stringify({
      ok: true,
      twilioStatus: resp.status,
      result: parsed,
      configured: {
        url: TWILIO_WEBHOOK_BASE_URL,
        filters,
      },
    }),
    { status: 200, headers: corsHeaders },
  );
});
