// admin-create-user — admin-only edge function for onboarding new users.
// Called by the /admin/drivers "Add driver" form and the /admin/settings
// "Invite user" dialog. Creates the auth.users row via Supabase Auth Admin
// API (the only place that can do that — direct INSERT bypasses password
// hashing + the handle_new_auth_user trigger flow), then patches the
// profiles row for the fields the trigger doesn't set (phone), and inserts
// the role-specific side row (drivers for role='driver', no extra needed
// for mechanic/admin since the trigger covers everything).
//
// Returns the new userId AND a one-time temporary password so the admin
// can hand it off or message it to the new hire. We strongly recommend the
// admin immediately triggers a password reset (the /login Forgot? flow)
// after creating the user so the temp password is rotated out.
//
// Auth: Bearer JWT with admin role, OR the SUPABASE_SERVICE_ROLE_KEY for
// CI / scripted onboarding.

interface CreateInput {
  email?: string;
  name?: string;
  phone?: string;
  role?: "admin" | "driver" | "mechanic";
  licenseNumber?: string; // driver-only
  licenseExpiry?: string; // driver-only, YYYY-MM-DD
}

function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Generate a random password — 16 chars from a URL-safe alphabet. The auth
// admin API enforces its own min-length (6 by default) so 16 is comfortably
// above that.
function genTempPassword(): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

function initialsFromName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "XX";
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

  // ---- Auth gate
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    return new Response(JSON.stringify({ error: "missing bearer token" }), {
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
    if (!uid) {
      return new Response(JSON.stringify({ error: "no user id in token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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

  // ---- Validate input
  let input: CreateInput;
  try {
    input = (await req.json()) as CreateInput;
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  const email = (input.email ?? "").trim().toLowerCase();
  const name = (input.name ?? "").trim();
  const phone = (input.phone ?? "").trim();
  const role = (input.role ?? "").trim() as "admin" | "driver" | "mechanic" | "";
  const licenseNumber = (input.licenseNumber ?? "").trim();
  const licenseExpiry = (input.licenseExpiry ?? "").trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return new Response(JSON.stringify({ error: "invalid email" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (!name) {
    return new Response(JSON.stringify({ error: "name required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (phone && !/^\+[1-9]\d{9,14}$/.test(phone)) {
    return new Response(JSON.stringify({ error: "phone must be E.164 (e.g. +14165550100) or empty" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (role !== "admin" && role !== "driver" && role !== "mechanic") {
    return new Response(JSON.stringify({ error: "role must be admin, driver, or mechanic" }), {
      status: 400,
      headers: corsHeaders,
    });
  }
  if (role === "driver") {
    if (!licenseNumber) {
      return new Response(JSON.stringify({ error: "licenseNumber required for driver" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry)) {
      return new Response(JSON.stringify({ error: "licenseExpiry required (YYYY-MM-DD) for driver" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
  }

  // ---- Create the auth user. raw_app_meta_data.role drives the
  // handle_new_auth_user trigger; raw_user_meta_data.name shows in the
  // dashboard + flows through to profiles.name via the same trigger.
  const tempPassword = genTempPassword();
  const adminUserResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: tempPassword,
      email_confirm: true, // skip the click-to-verify; admin vouches for the address
      app_metadata: { role },
      user_metadata: { name },
    }),
  });
  if (!adminUserResp.ok) {
    const raw = await adminUserResp.text();
    return new Response(
      JSON.stringify({
        error: `auth admin createUser failed: HTTP ${adminUserResp.status} — ${raw.slice(0, 300)}`,
      }),
      { status: adminUserResp.status >= 500 ? 502 : 400, headers: corsHeaders },
    );
  }
  const created = await adminUserResp.json();
  const newUserId = created?.user?.id ?? created?.id;
  if (!newUserId) {
    return new Response(
      JSON.stringify({ error: "auth admin createUser returned no user id" }),
      { status: 502, headers: corsHeaders },
    );
  }

  // ---- The trigger created profiles(id, email, name, role). It does NOT
  // set phone — patch that ourselves.
  if (phone) {
    const patchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(newUserId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ phone }),
      },
    );
    if (!patchResp.ok) {
      // Don't roll back the auth user — partial success is recoverable from
      // the admin UI (set phone via /admin/drivers pencil). Surface a warning.
      const raw = await patchResp.text();
      return new Response(
        JSON.stringify({
          ok: true,
          userId: newUserId,
          tempPassword,
          warning: `User created but phone patch failed: ${raw.slice(0, 200)}. Set via /admin/drivers.`,
        }),
        { status: 200, headers: corsHeaders },
      );
    }
  }

  // ---- Role-specific side rows
  if (role === "driver") {
    const driverInsResp = await fetch(`${SUPABASE_URL}/rest/v1/drivers`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        id: newUserId,
        license_number: licenseNumber,
        license_expiry: licenseExpiry,
        initials: initialsFromName(name),
      }),
    });
    if (!driverInsResp.ok) {
      const raw = await driverInsResp.text();
      return new Response(
        JSON.stringify({
          ok: true,
          userId: newUserId,
          tempPassword,
          warning: `User created but drivers row failed: ${raw.slice(0, 200)}. Admin needs to repair the drivers table manually.`,
        }),
        { status: 200, headers: corsHeaders },
      );
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      userId: newUserId,
      tempPassword,
      hint: "Send the temp password to the user. They should change it on first login via the Forgot? link.",
    }),
    { status: 200, headers: corsHeaders },
  );
});
