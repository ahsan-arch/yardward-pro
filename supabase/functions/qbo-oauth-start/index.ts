// Supabase Edge Function: qbo-oauth-start
//
// Returns the Intuit authorize URL the admin's browser should navigate to in
// order to begin the QBO OAuth 2.0 authorization-code flow. Generates a
// random `state` token the caller MUST send back with the callback exchange
// to defeat CSRF.
//
// Why this exists:
//   The qbo_oauth_tokens row is the source of refresh_token + realm_id for
//   every downstream QBO call. Until now, those values had to be obtained
//   manually (Postman / Intuit OAuth Playground) and pasted into the DB via
//   `supabase db query`. This function (plus qbo-oauth-callback) lets an
//   admin click "Connect QuickBooks" in /admin/settings → Integrations and
//   complete the handshake from the app itself.
//
// Auth: admin user JWT or service_role bearer.
// Returns: { authorizeUrl: string, state: string, redirectUri: string }
//
// Required env:
//   QBO_CLIENT_ID         — Intuit-issued client id
//   QBO_REDIRECT_URI      — must exactly match the Redirect URI registered in
//                           the Intuit Developer Portal (and the one the
//                           frontend route /admin/settings/qbo-callback will
//                           handle)
//   QBO_ENVIRONMENT       — "production" or "sandbox" (controls scope only;
//                           Intuit's authorize host is the same for both)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// 32 bytes of crypto-random hex — same entropy class the Twilio webhook uses
// for nonces. We do NOT persist this server-side; CSRF protection comes from
// the frontend round-tripping it through sessionStorage and matching it to
// the URL query param after Intuit's redirect.
function randomState(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
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
  const redirectUri = Deno.env.get("QBO_REDIRECT_URI") ?? "";
  if (!clientId) return jsonOk({ error: "QBO_CLIENT_ID not set" }, 500);
  if (!redirectUri) {
    return jsonOk(
      {
        error:
          "QBO_REDIRECT_URI not set — set it to the URL you registered as Redirect URI in the Intuit Developer Portal (e.g. https://yardward.pro/admin/settings/qbo-callback)",
      },
      500,
    );
  }

  const state = randomState();
  // Scopes:
  //   com.intuit.quickbooks.accounting — invoice + customer (qbo-push-invoice)
  //   com.intuit.quickbooks.payroll    — timesheets (qbo-push-time)
  // openid + profile + email are required for the OpenID-Connect flavor of
  // the authorize endpoint Intuit uses, and they don't add risk.
  const scope = [
    "com.intuit.quickbooks.accounting",
    "com.intuit.quickbooks.payroll",
    "openid",
    "profile",
    "email",
  ].join(" ");

  const authorizeUrl =
    "https://appcenter.intuit.com/connect/oauth2" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}`;

  return jsonOk({ authorizeUrl, state, redirectUri });
});
