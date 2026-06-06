// admin-rotate-password — admin-only edge function that resets any user's
// password via the Supabase Auth Admin API. Generates a strong random
// password if none is supplied. Returns the new password to the caller so
// the admin can hand it off to the user (same pattern as the temp password
// returned by admin-create-user).
//
// Body: { targetUserId?: string, targetEmail?: string, newPassword?: string }
//   - one of targetUserId or targetEmail must be provided
//   - newPassword optional; if omitted, generate a 24-char URL-safe random.
//
// Auth: Bearer JWT with admin role OR SUPABASE_SERVICE_ROLE_KEY.

interface Input {
  targetUserId?: string;
  targetEmail?: string;
  newPassword?: string;
}

function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function genPassword(len = 24): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "missing supabase env" }), {
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
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role`,
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

  // Parse + resolve target
  let body: Input;
  try {
    body = (await req.json()) as Input;
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  let targetUserId = (body.targetUserId ?? "").trim();
  const targetEmail = (body.targetEmail ?? "").trim().toLowerCase();
  if (!targetUserId && !targetEmail) {
    return new Response(
      JSON.stringify({ error: "targetUserId or targetEmail required" }),
      { status: 400, headers: corsHeaders },
    );
  }
  if (!targetUserId && targetEmail) {
    // Resolve email → uuid via the Admin API list-users endpoint.
    const listResp = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(targetEmail)}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!listResp.ok) {
      const raw = await listResp.text();
      return new Response(
        JSON.stringify({ error: `lookup by email failed: HTTP ${listResp.status} — ${raw.slice(0, 200)}` }),
        { status: 502, headers: corsHeaders },
      );
    }
    const listData = await listResp.json();
    const users = listData?.users ?? [];
    const found = Array.isArray(users) ? users.find((u: { email?: string }) => u.email?.toLowerCase() === targetEmail) : null;
    if (!found?.id) {
      return new Response(
        JSON.stringify({ error: `no user found for email ${targetEmail}` }),
        { status: 404, headers: corsHeaders },
      );
    }
    targetUserId = found.id;
  }

  const newPassword = (body.newPassword ?? "").trim() || genPassword();
  if (newPassword.length < 8) {
    return new Response(JSON.stringify({ error: "newPassword must be ≥8 chars" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // Apply via Auth Admin API
  const patchResp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(targetUserId)}`,
    {
      method: "PUT",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    },
  );
  if (!patchResp.ok) {
    const raw = await patchResp.text();
    return new Response(
      JSON.stringify({
        ok: false,
        error: `auth admin updateUser failed: HTTP ${patchResp.status} — ${raw.slice(0, 300)}`,
      }),
      { status: patchResp.status >= 500 ? 502 : 400, headers: corsHeaders },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      targetUserId,
      newPassword,
      hint: "Save this password — it cannot be recovered if lost. Recipient should rotate via /login → Forgot? after first sign-in.",
    }),
    { status: 200, headers: corsHeaders },
  );
});
