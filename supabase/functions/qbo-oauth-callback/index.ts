// Supabase Edge Function: qbo-oauth-callback
//
// Exchanges the authorization code returned by Intuit (after the admin
// completes the OAuth consent at appcenter.intuit.com) for a refresh_token +
// access_token + realm_id, and persists them to qbo_oauth_tokens (singleton
// row id='default').
//
// Auth: admin user JWT or service_role bearer.
// Body: { code: string, realmId: string, state: string, expectedState: string }
//   - state         = the state Intuit echoed back in the redirect URL
//   - expectedState = the state the frontend stashed in sessionStorage when
//                     qbo-oauth-start returned. We require them to match
//                     (constant-time) before exchanging — defeats CSRF where
//                     someone tricks an authenticated admin into hitting
//                     this endpoint with an attacker's `code`.
//
// After a successful exchange:
//   1. UPSERT id='default' with the new refresh_token, access_token (cleared
//      so the next downstream call refreshes — Intuit's authorize-code
//      response DOES include an access_token, but we deliberately store
//      access_token_expires_at = NULL so the shared helper's fast path is
//      bypassed once and the lock path runs end-to-end. This proves the
//      stored refresh_token works before we report success.)
//   2. Return { ok, realmId, env, refreshedSelfTest: true|false }.
//
// Required env:
//   QBO_CLIENT_ID
//   QBO_CLIENT_SECRET
//   QBO_REDIRECT_URI    (must equal the value sent to Intuit by qbo-oauth-start)
//   QBO_ENVIRONMENT     (sandbox|production — used only for the diagnostic ping)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getQboAccessToken, qboApiHost } from "../_shared/qbo-oauth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonOk(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    headers: { ...cors, "Content-Type": "application/json" },
    status,
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyAdminOrServiceRole(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  serviceRoleKey: string,
): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return jsonOk({ error: "Missing or malformed Authorization header" }, 401);
  }
  const token = authHeader.slice(7).trim();
  if (!token) return jsonOk({ error: "Empty bearer token" }, 401);
  if (serviceRoleKey && constantTimeEqual(token, serviceRoleKey)) return null;

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonOk({ error: "Invalid or expired user token" }, 401);
  }
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileErr } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileErr || !profile || profile.role !== "admin") {
    return jsonOk({ error: "Admin privileges required" }, 401);
  }
  return null;
}

// Belt-and-suspenders handler wrapper — ensures EVERY exception path returns
// a structured JSON error to the caller instead of letting Deno serve a bare
// 500 (which would leave supabase-js with no body to extract, surfacing as
// the opaque "Edge Function returned a non-2xx status code" string in the
// SPA). Also logs to console.error so the same diagnostic shows up in the
// Supabase Edge Function logs dashboard.
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonOk({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return jsonOk({ error: "Missing supabase env" }, 500);
  }

  const authFailure = await verifyAdminOrServiceRole(
    req,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY,
  );
  if (authFailure) return authFailure;

  const clientId = Deno.env.get("QBO_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("QBO_CLIENT_SECRET") ?? "";
  const redirectUri = Deno.env.get("QBO_REDIRECT_URI") ?? "";
  if (!clientId || !clientSecret) {
    return jsonOk({ error: "QBO_CLIENT_ID + QBO_CLIENT_SECRET must be set" }, 500);
  }
  if (!redirectUri) {
    return jsonOk({ error: "QBO_REDIRECT_URI not set" }, 500);
  }

  let body: { code?: string; realmId?: string; state?: string; expectedState?: string };
  try {
    body = await req.json();
  } catch {
    return jsonOk({ error: "Body must be JSON" }, 400);
  }
  const code = (body.code ?? "").trim();
  const realmId = (body.realmId ?? "").trim();
  const state = (body.state ?? "").trim();
  const expectedState = (body.expectedState ?? "").trim();
  if (!code) return jsonOk({ error: "code required" }, 400);
  if (!realmId) return jsonOk({ error: "realmId required" }, 400);
  if (!state || !expectedState) {
    return jsonOk({ error: "state + expectedState required" }, 400);
  }
  // Constant-time compare — same defense the auth gate uses for the service
  // role key. A timing-side-channel here would let an attacker brute-force
  // matching state tokens.
  if (!constantTimeEqual(state, expectedState)) {
    return jsonOk({ error: "state mismatch — possible CSRF; restart the flow" }, 400);
  }

  // ---- Exchange the code with Intuit ---------------------------------------
  // Wrap the network call so a transient DNS/TLS/timeout doesn't bubble up as
  // a bare 500 — supabase-js cannot extract a body from those and the SPA
  // shows the opaque "non-2xx" string. Capture and structure the error.
  let tokenRes: Response;
  // Intuit's OAuth 2.0 token endpoint per the discovery doc at
  // https://developer.api.intuit.com/.well-known/openid_connect_configuration
  // is /oauth2/v1/tokens/bearer (NOT /tokens). The /tokens path returns 404.
  const tokenEndpoint = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
  // VERSION MARKER — if you see this in Supabase function logs, the new
  // deploy is active. If you see 404 in production logs but DON'T see this
  // marker, the deploy hasn't propagated.
  console.log("qbo-oauth-callback v=BEARER-FIX-2 endpoint=", tokenEndpoint);
  try {
    tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(clientId + ":" + clientSecret),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("qbo-oauth-callback: token-exchange network error", msg);
    return jsonOk(
      {
        ok: false,
        step: "code-exchange",
        error: `Network error reaching Intuit token endpoint: ${msg}`,
        hint: "Check Supabase function egress + try again. If this persists, the project may be cold-starting; retry after 10s.",
      },
      502,
    );
  }
  const tokenBodyText = await tokenRes.text();
  if (!tokenRes.ok) {
    console.error(
      `qbo-oauth-callback: Intuit token exchange failed HTTP ${tokenRes.status}`,
      tokenBodyText.slice(0, 500),
    );
    return jsonOk(
      {
        ok: false,
        step: "code-exchange",
        intuitStatus: tokenRes.status,
        intuitError: tokenBodyText.slice(0, 500),
        hint: "Most common cause: QBO_REDIRECT_URI does not match the Redirect URI registered in the Intuit Developer Portal exactly (scheme + host + path). Second most common: the authorization code was already used (single-use) — restart the Connect flow.",
      },
      400,
    );
  }
  let tokenJson: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
    token_type: string;
  };
  try {
    tokenJson = JSON.parse(tokenBodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("qbo-oauth-callback: token-exchange JSON parse error", msg, tokenBodyText.slice(0, 300));
    return jsonOk(
      {
        ok: false,
        step: "code-exchange",
        error: `Intuit returned 200 OK but body was not JSON: ${msg}`,
        intuitError: tokenBodyText.slice(0, 300),
      },
      502,
    );
  }
  if (!tokenJson.refresh_token) {
    return jsonOk(
      { ok: false, step: "code-exchange", error: "Intuit response missing refresh_token" },
      502,
    );
  }

  // ---- Persist to qbo_oauth_tokens -----------------------------------------
  // UPSERT id='default'. We deliberately set access_token + expiry to NULL
  // so the next downstream QBO call hits the lock-path of the shared helper,
  // refreshing the token AND proving the stored refresh_token works. If we
  // stored the access_token returned by the authorize-code exchange, a
  // broken refresh_token wouldn't surface until 60 minutes later.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const nowIso = new Date().toISOString();
  const { error: upErr } = await admin.from("qbo_oauth_tokens").upsert(
    {
      id: "default",
      refresh_token: tokenJson.refresh_token,
      realm_id: realmId,
      access_token: null,
      access_token_expires_at: null,
      updated_at: nowIso,
    },
    { onConflict: "id" },
  );
  if (upErr) {
    return jsonOk(
      {
        ok: false,
        step: "persist",
        error: `Failed to persist qbo_oauth_tokens: ${upErr.message}`,
      },
      500,
    );
  }

  // ---- Self-test: force a refresh + CompanyInfo ping -----------------------
  // Same code path as qbo-diagnose. If this fails, the OAuth handshake
  // succeeded but the connection isn't actually usable — most often because
  // QBO_ENVIRONMENT (sandbox vs production) doesn't match the realm the
  // admin authorized. Reporting that here saves an admin a confused round
  // trip through /admin/settings → Integrations → Refresh.
  let selfTestOk = false;
  let selfTestMsg: string | null = null;
  try {
    const tok = await getQboAccessToken(admin, Deno.env);
    const apiHost = qboApiHost(Deno.env);
    const ciRes = await fetch(
      `${apiHost}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`,
      { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" } },
    );
    if (ciRes.ok) {
      selfTestOk = true;
      selfTestMsg = "CompanyInfo authorized";
    } else {
      const detail = (await ciRes.text()).slice(0, 300);
      selfTestMsg =
        ciRes.status === 401
          ? `CompanyInfo returned 401 — QBO_ENVIRONMENT (${Deno.env.get("QBO_ENVIRONMENT") ?? "sandbox"}) likely does not match the realm you authorized. Re-run setting the secret to "production" (or the other way around).`
          : `CompanyInfo returned ${ciRes.status}: ${detail}`;
    }
  } catch (err) {
    selfTestMsg = err instanceof Error ? err.message : String(err);
  }

  return jsonOk({
    ok: true,
    realmId,
    env: Deno.env.get("QBO_ENVIRONMENT") ?? "sandbox",
    refreshedSelfTest: selfTestOk,
    selfTestMsg,
  });
}

// Outer serve wrapper — catches ANY exception bubbling out of handle() and
// converts it into a structured JSON response. Without this, an uncaught
// throw in the handler causes Deno to return a bare 500 with no body, and
// supabase-js surfaces that to the SPA as "Edge Function returned a non-2xx
// status code" with no actionable info. Now the SPA always gets {ok:false,
// error, step:"unhandled"} and console.error makes the same diagnostic show
// up in the Supabase Function logs dashboard for after-the-fact debugging.
serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? "" : "";
    console.error("qbo-oauth-callback: UNHANDLED exception", msg, stack);
    return jsonOk(
      {
        ok: false,
        step: "unhandled",
        error: `Unhandled exception in qbo-oauth-callback: ${msg}`,
        stack: stack.slice(0, 1000),
      },
      500,
    );
  }
});
