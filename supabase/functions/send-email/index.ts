// Supabase Edge Function: send-email
//
// Generic transactional email send via Resend. Admin-gated; the actual HTTP
// call to Resend is in _shared/email.ts so admin-create-user (invite flow)
// reuses the same code path without bouncing through this function.
//
// Auth: admin user JWT or service_role bearer.
// Body: { to, subject, html?, text?, from?, replyTo?, cc?, bcc? }
//
// Required env (read by sendResendEmail):
//   RESEND_API_KEY
//   RESEND_FROM_DEFAULT  ("Yardward Pro <noreply@yardward.pro>")

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail, type ResendEmailPayload } from "../_shared/email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
  const authHeader =
    req.headers.get("Authorization") ?? req.headers.get("authorization");
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

  let body: ResendEmailPayload;
  try {
    body = (await req.json()) as ResendEmailPayload;
  } catch {
    return jsonOk({ error: "Body must be JSON" }, 400);
  }
  if (!body.to || (typeof body.to !== "string" && !Array.isArray(body.to))) {
    return jsonOk({ error: "to required (string or string[])" }, 400);
  }
  if (!body.subject || typeof body.subject !== "string") {
    return jsonOk({ error: "subject required" }, 400);
  }
  if (!body.html && !body.text) {
    return jsonOk({ error: "html or text required" }, 400);
  }

  const result = await sendResendEmail(Deno.env, body);
  if (!result.ok) {
    return jsonOk(
      {
        ok: false,
        provider: "resend",
        status: result.status,
        error: result.error,
        errorName: result.errorName ?? null,
      },
      // Config + auth + verification failures (400 domain-mismatch, 401/403
      // Resend auth, 500 missing env) → 400 so the toast surfaces an
      // actionable error. Other failures (network, 5xx from Resend) → 502 so
      // monitoring distinguishes our bugs from Resend outages.
      result.status === 400 ||
      result.status === 401 ||
      result.status === 403 ||
      result.status === 500
        ? 400
        : 502,
    );
  }
  return jsonOk({ ok: true, id: result.id });
});
