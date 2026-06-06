// twilio-verify — admin-only diagnostic that probes Twilio with the
// configured TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN and verifies the
// TWILIO_FROM_NUMBER is owned by the account. No SMS is sent and no
// secret values are returned in the response — only structured ok/error.
//
// Hits two Twilio endpoints:
//   GET /Accounts/{Sid}.json                                 — auth check
//   GET /Accounts/{Sid}/IncomingPhoneNumbers.json?PhoneNumber  — from number check

interface VerifyResult {
  // Phase 1 — basic creds for outbound SMS via twilio-send-sms
  accountValid: boolean;
  accountStatus: string | null;
  accountFriendlyName: string | null;
  accountSidPrefix: string | null;
  fromNumberConfigured: boolean;
  fromNumberOwned: boolean;
  fromNumberSmsCapable: boolean | null;
  fromNumberMmsCapable: boolean | null;
  fromNumberPrefix: string | null;
  // Phase 2 — Twilio Conversations API
  apiKeyConfigured: boolean;
  apiKeyValid: boolean;
  apiKeySidPrefix: string | null;
  conversationsServiceConfigured: boolean;
  conversationsServiceFound: boolean;
  conversationsServiceFriendlyName: string | null;
  conversationsServiceSidPrefix: string | null;
  errors: string[];
}

// Constant-time string compare for the admin bearer check — same pattern
// twilio-send-sms uses (we keep it self-contained here).
function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function getJson<T>(url: string, basicAuth: string): Promise<{ ok: boolean; status: number; body: T | null; raw: string }> {
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
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

  // ---- Auth gate: admin only (Bearer service-role OR an authed admin JWT)
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing bearer token" }), {
      status: 401,
      headers: corsHeaders,
    });
  }
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!serviceRoleKey || !supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
  const isServiceRole = eqConstTime(bearer, serviceRoleKey);
  if (!isServiceRole) {
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${bearer}`, apikey: anonKey },
    });
    if (!userResp.ok) {
      return new Response(JSON.stringify({ error: "invalid token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const userData = await userResp.json();
    const uid = userData?.id;
    if (!uid) {
      return new Response(JSON.stringify({ error: "no user id in token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const profResp = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${uid}&select=role`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    const profRows = (await profResp.json()) as Array<{ role: string }>;
    if (!Array.isArray(profRows) || profRows[0]?.role !== "admin") {
      return new Response(JSON.stringify({ error: "admin role required" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
  }

  // ---- Probe Twilio
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
  const TWILIO_API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID") ?? "";
  const TWILIO_API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET") ?? "";
  const TWILIO_CONVERSATIONS_SERVICE_SID =
    Deno.env.get("TWILIO_CONVERSATIONS_SERVICE_SID") ?? "";

  const result: VerifyResult = {
    accountValid: false,
    accountStatus: null,
    accountFriendlyName: null,
    accountSidPrefix: TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.slice(0, 6) + "…" : null,
    fromNumberConfigured: !!TWILIO_FROM_NUMBER,
    fromNumberOwned: false,
    fromNumberSmsCapable: null,
    fromNumberMmsCapable: null,
    fromNumberPrefix: TWILIO_FROM_NUMBER ? TWILIO_FROM_NUMBER.slice(0, 6) + "…" : null,
    apiKeyConfigured: !!TWILIO_API_KEY_SID && !!TWILIO_API_KEY_SECRET,
    apiKeyValid: false,
    apiKeySidPrefix: TWILIO_API_KEY_SID ? TWILIO_API_KEY_SID.slice(0, 6) + "…" : null,
    conversationsServiceConfigured: !!TWILIO_CONVERSATIONS_SERVICE_SID,
    conversationsServiceFound: false,
    conversationsServiceFriendlyName: null,
    conversationsServiceSidPrefix: TWILIO_CONVERSATIONS_SERVICE_SID
      ? TWILIO_CONVERSATIONS_SERVICE_SID.slice(0, 6) + "…"
      : null,
    errors: [],
  };

  // Format sanity checks (catch demo placeholders before hitting Twilio).
  if (!TWILIO_ACCOUNT_SID) {
    result.errors.push("TWILIO_ACCOUNT_SID is not set");
  } else if (!/^AC[0-9a-f]{32}$/i.test(TWILIO_ACCOUNT_SID)) {
    result.errors.push("TWILIO_ACCOUNT_SID is not the expected format (AC + 32 hex chars)");
  }
  if (!TWILIO_AUTH_TOKEN) {
    result.errors.push("TWILIO_AUTH_TOKEN is not set");
  } else if (TWILIO_AUTH_TOKEN.length < 32) {
    result.errors.push("TWILIO_AUTH_TOKEN is shorter than expected (32 chars)");
  }
  if (!TWILIO_FROM_NUMBER) {
    result.errors.push("TWILIO_FROM_NUMBER is not set");
  } else if (!/^\+[1-9]\d{9,14}$/.test(TWILIO_FROM_NUMBER)) {
    result.errors.push("TWILIO_FROM_NUMBER is not E.164 format (e.g. +15551234567)");
  }

  // Phase 2 format checks. These are warnings, not blockers — Phase 1 SMS
  // still works without them.
  if (TWILIO_API_KEY_SID && !/^SK[0-9a-f]{32}$/i.test(TWILIO_API_KEY_SID)) {
    result.errors.push(
      "TWILIO_API_KEY_SID is not the expected format (SK + 32 hex chars)",
    );
  }
  if (TWILIO_API_KEY_SECRET && TWILIO_API_KEY_SECRET.length < 32) {
    result.errors.push(
      "TWILIO_API_KEY_SECRET is shorter than expected (32 chars)",
    );
  }
  if (
    TWILIO_CONVERSATIONS_SERVICE_SID &&
    !/^IS[0-9a-f]{32}$/i.test(TWILIO_CONVERSATIONS_SERVICE_SID)
  ) {
    result.errors.push(
      "TWILIO_CONVERSATIONS_SERVICE_SID is not the expected format (IS + 32 hex chars)",
    );
  }

  // Only bail if the Phase 1 basics are broken — Phase 2 is optional.
  const phase1Broken =
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_FROM_NUMBER ||
    !/^AC[0-9a-f]{32}$/i.test(TWILIO_ACCOUNT_SID) ||
    TWILIO_AUTH_TOKEN.length < 32 ||
    !/^\+[1-9]\d{9,14}$/.test(TWILIO_FROM_NUMBER);
  if (phase1Broken) {
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: corsHeaders,
    });
  }

  // ---- Live probe 1: Account fetch
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  type TwilioAccount = {
    sid: string;
    friendly_name: string;
    status: string;
    type: string;
  };
  const acct = await getJson<TwilioAccount>(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`,
    basicAuth,
  );
  if (acct.ok && acct.body) {
    result.accountValid = true;
    result.accountStatus = acct.body.status ?? null;
    result.accountFriendlyName = acct.body.friendly_name ?? null;
  } else if (acct.status === 401) {
    result.errors.push(
      "Twilio 401 — credentials rejected. Account SID and/or auth token are wrong.",
    );
  } else if (acct.status === 404) {
    result.errors.push(
      "Twilio 404 — Account SID not found. Check that the SID matches your Twilio account.",
    );
  } else if (acct.status === 0) {
    result.errors.push(`Network error reaching Twilio: ${acct.raw.slice(0, 200)}`);
  } else {
    result.errors.push(
      `Twilio account probe failed: HTTP ${acct.status} — ${acct.raw.slice(0, 200)}`,
    );
  }

  // ---- Live probe 2: From number owned by account
  if (result.accountValid) {
    type TwilioNumbers = {
      incoming_phone_numbers?: Array<{
        phone_number: string;
        capabilities?: { sms?: boolean; mms?: boolean };
      }>;
    };
    const nums = await getJson<TwilioNumbers>(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(TWILIO_FROM_NUMBER)}`,
      basicAuth,
    );
    if (nums.ok && nums.body?.incoming_phone_numbers && nums.body.incoming_phone_numbers.length > 0) {
      const match = nums.body.incoming_phone_numbers[0];
      result.fromNumberOwned = true;
      result.fromNumberSmsCapable = match.capabilities?.sms ?? null;
      result.fromNumberMmsCapable = match.capabilities?.mms ?? null;
    } else if (nums.ok) {
      result.errors.push(
        `TWILIO_FROM_NUMBER (${result.fromNumberPrefix}) is not owned by this Twilio account. Buy/port the number first or update the secret to a number you own.`,
      );
    } else if (nums.status === 401) {
      // Same creds passed account check but failed here → odd, surface raw.
      result.errors.push(
        `From-number probe got 401 unexpectedly: ${nums.raw.slice(0, 200)}`,
      );
    } else {
      result.errors.push(
        `From-number probe failed: HTTP ${nums.status} — ${nums.raw.slice(0, 200)}`,
      );
    }
  }

  // ---- Live probe 3: API Key auth (Phase 2)
  if (result.apiKeyConfigured && TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    const apiKeyAuth = btoa(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`);
    type TwilioAccount = { sid: string };
    const probe = await getJson<TwilioAccount>(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json`,
      apiKeyAuth,
    );
    if (probe.ok && probe.body) {
      result.apiKeyValid = true;
    } else if (probe.status === 401) {
      result.errors.push(
        "Twilio API key probe got 401 — TWILIO_API_KEY_SID and/or TWILIO_API_KEY_SECRET are wrong, or the key doesn't belong to this account.",
      );
    } else if (probe.status === 0) {
      result.errors.push(
        `Network error reaching Twilio for API key probe: ${probe.raw.slice(0, 200)}`,
      );
    } else {
      result.errors.push(
        `API key probe failed: HTTP ${probe.status} — ${probe.raw.slice(0, 200)}`,
      );
    }
  } else if (TWILIO_API_KEY_SID || TWILIO_API_KEY_SECRET) {
    result.errors.push(
      "TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must BOTH be set (only one is configured).",
    );
  }

  // ---- Live probe 4: Conversations service exists (Phase 2)
  if (
    result.conversationsServiceConfigured &&
    TWILIO_CONVERSATIONS_SERVICE_SID &&
    result.apiKeyValid
  ) {
    type ConversationsService = {
      sid: string;
      friendly_name: string;
    };
    // Conversations API works with either account auth or API key auth;
    // we use the API key (preferred — matches what the production functions
    // will use).
    const apiKeyAuth = btoa(`${TWILIO_API_KEY_SID}:${TWILIO_API_KEY_SECRET}`);
    const svc = await getJson<ConversationsService>(
      `https://conversations.twilio.com/v1/Services/${TWILIO_CONVERSATIONS_SERVICE_SID}`,
      apiKeyAuth,
    );
    if (svc.ok && svc.body) {
      result.conversationsServiceFound = true;
      result.conversationsServiceFriendlyName = svc.body.friendly_name ?? null;
    } else if (svc.status === 404) {
      result.errors.push(
        "TWILIO_CONVERSATIONS_SERVICE_SID not found. Either the SID is wrong or the Conversations Service was deleted.",
      );
    } else if (svc.status === 401 || svc.status === 403) {
      result.errors.push(
        `Conversations service probe got HTTP ${svc.status} — the API key may not have access to Conversations resources.`,
      );
    } else {
      result.errors.push(
        `Conversations service probe failed: HTTP ${svc.status} — ${svc.raw.slice(0, 200)}`,
      );
    }
  }

  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: corsHeaders,
  });
});
