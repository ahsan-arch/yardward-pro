// Shared admin/service-role auth gate for edge functions.
//
// Every admin-only function in this project needs the same check: accept the
// SUPABASE_SERVICE_ROLE_KEY as a bearer (CI / cron), otherwise resolve the
// bearer as a user JWT and require profiles.role = 'admin'. Until now each
// function carried its own inline copy (~12 of them); new functions should
// import from here instead. (Migrating the existing copies is a separate,
// deliberate change — the gate is security-critical and each migration
// deserves its own review.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns null when authorized; otherwise a ready-to-return JSON Response
// carrying the provided CORS headers.
export async function verifyAdminOrServiceRole(
  req: Request,
  opts: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    serviceRoleKey: string;
    corsHeaders: Record<string, string>;
  },
): Promise<Response | null> {
  const deny = (error: string, status: number) =>
    new Response(JSON.stringify({ error }), {
      headers: { ...opts.corsHeaders, "Content-Type": "application/json" },
      status,
    });

  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return deny("Missing or malformed Authorization header", 401);
  }
  const token = authHeader.slice(7).trim();
  if (!token) return deny("Empty bearer token", 401);
  if (opts.serviceRoleKey && constantTimeEqual(token, opts.serviceRoleKey)) return null;

  const userClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) {
    return deny("Invalid or expired user token", 401);
  }
  const adminClient = createClient(opts.supabaseUrl, opts.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile, error: profileErr } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileErr || !profile || profile.role !== "admin") {
    return deny("Admin privileges required", 403);
  }
  return null;
}
