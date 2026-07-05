// admin-create-user — admin-only edge function for onboarding new users.
// Called by the /admin/drivers "Add driver" form and the /admin/settings
// "Invite user" dialog. Creates the auth.users row via Supabase Auth Admin
// API (the only place that can do that — direct INSERT bypasses password
// hashing + the handle_new_auth_user trigger flow), then patches the
// profiles row for the fields the trigger doesn't set (phone), and inserts
// the role-specific side row (drivers for role='driver', no extra needed
// for mechanic/admin since the trigger covers everything).
//
// REASSIGN: if the submitted email already has an auth user, we do NOT error
// with "already registered". Instead we treat the submit as a reassignment —
// update that user's name / phone / role, reconcile their role side-row
// (drivers/mechanics upsert), and re-issue their invite or reset their temp
// password. The pre-existing auth user is never deleted. The response carries
// `reassigned: true` so the SPA can say "updated" instead of "created".
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
  // When true, after creating the user we ALSO generate a Supabase recovery
  // link and send a branded invite email via Resend. The temp password we
  // generated is still saved on the auth row (so an admin can fall back to
  // sharing it manually) but it's NOT returned to the caller — the email
  // is the canonical delivery path. If Resend isn't configured, we surface
  // an error and the admin can retry with sendInviteEmail=false.
  sendInviteEmail?: boolean;
  // Optional override URL the recovery link should redirect to after the
  // user sets their password. Defaults to the SITE_URL secret +
  // /reset-password.
  redirectTo?: string;
  // Optional named custom admin role (admin_roles.id) restricting which
  // admin tabs the new/reassigned admin can see. Only meaningful when
  // role === "admin"; ignored otherwise. Owner-only (see auth gate).
  adminRoleId?: string;
}

function eqConstTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Generate a random password — 16 chars from a URL-safe alphabet. The auth
// admin API enforces its own min-length (8 after the policy reconciliation)
// so 16 is comfortably above that.
import { generatePassword } from "../_shared/password.ts";
import { sendResendEmail, buildInviteEmail } from "../_shared/email.ts";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
  // Owner status of the caller. Creating/reassigning ADMIN users is owner-only
  // (an admin restricted via the owner/custom-roles feature must not be able
  // to mint a fresh full-access admin account and log into it). service_role
  // callers are trusted automation and count as owner.
  let callerIsOwner = isServiceRole;
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
    // is_owner may not exist yet in an environment where the owner/custom-
    // roles SQL hasn't been applied — fall back to a role-only select there
    // (caller then counts as non-owner, which only blocks admin creation).
    let profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role,is_owner`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!profResp.ok) {
      profResp = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
    }
    const profRows = (await profResp.json()) as Array<{ role: string; is_owner?: boolean }>;
    if (!Array.isArray(profRows) || profRows[0]?.role !== "admin") {
      return new Response(JSON.stringify({ error: "admin role required" }), {
        status: 403,
        headers: corsHeaders,
      });
    }
    callerIsOwner = profRows[0]?.is_owner === true;
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
  const sendInviteEmail = input.sendInviteEmail === true;
  const redirectToOverride = (input.redirectTo ?? "").trim();

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
  // Creating or reassigning-to ADMIN is owner-only. Driver/mechanic
  // onboarding stays available to every admin (unchanged behavior).
  if (role === "admin" && !callerIsOwner) {
    return new Response(
      JSON.stringify({ error: "owner admin required to create or reassign admin users" }),
      { status: 403, headers: corsHeaders },
    );
  }
  // Optional custom-role assignment (admin targets only). Validate it exists
  // up front so a typo'd id fails the request instead of silently creating a
  // full-access admin.
  const adminRoleId = role === "admin" ? (input.adminRoleId ?? "").trim() : "";
  if (adminRoleId) {
    const roleResp = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_roles?id=eq.${encodeURIComponent(adminRoleId)}&select=id`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    const roleRows = roleResp.ok ? ((await roleResp.json()) as Array<{ id: string }>) : [];
    if (!Array.isArray(roleRows) || !roleRows[0]?.id) {
      return new Response(JSON.stringify({ error: "adminRoleId not found" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
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

  // ---- Create the auth user, OR reassign an existing one.
  // We generate the temp password up front: the fresh-create path passes it
  // into the POST; the reassign path (email already registered) PATCHes it
  // onto the existing user when we're NOT sending an email invite, so the
  // admin still gets a credential to hand over.
  //
  // raw_app_meta_data.role drives the handle_new_auth_user trigger;
  // raw_user_meta_data.name shows in the dashboard + flows through to
  // profiles.name via the same trigger.
  const tempPassword = generatePassword(16);

  // Helper for rolling back the auth user when a subsequent CREATE step
  // fails. NEVER called on the reassign path — that user pre-existed and
  // deleting it would destroy a real account. On the create path the drivers
  // row is essential (license_number NOT NULL; initials shown everywhere),
  // so if it can't be inserted cleanly we delete the just-made auth.users row
  // to keep onboarding atomic. Phone failures are softer: the user is usable
  // without a phone (just no SMS); we keep them and surface a loud warning.
  async function deleteAuthUser(userId: string): Promise<boolean> {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: "DELETE",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  let userId: string;
  let reassigned = false;
  let phoneWarning: string | null = null;

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

  if (adminUserResp.ok) {
    // ---- Fresh create path -------------------------------------------------
    const created = await adminUserResp.json();
    const newUserId = created?.user?.id ?? created?.id;
    if (!newUserId) {
      return new Response(
        JSON.stringify({ error: "auth admin createUser returned no user id" }),
        { status: 502, headers: corsHeaders },
      );
    }
    userId = newUserId;

    // The trigger created profiles(id, email, name, role) but does NOT set
    // phone. Patching phone is non-fatal: the user exists and can sign in;
    // admin can set it later. We surface a `warning` field the SPA toasts.
    if (phone) {
      const patchResp = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
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
        const raw = await patchResp.text();
        phoneWarning = `Phone (${phone}) was NOT saved: HTTP ${patchResp.status} — ${raw.slice(0, 150)}. Set it manually via /admin/drivers → pencil. SMS will not deliver until you do.`;
      }
    }

    // Make the requested ROLE authoritative, and apply the custom-role
    // restriction, in one FATAL patch (rollback on failure).
    //
    // Role: handle_new_auth_user only trusts raw_app_meta_data->>'role' and
    // silently defaults anything it can't read to 'driver'. The GoTrue admin
    // create endpoint does not reliably surface our app_metadata.role to that
    // trigger, so a role=admin/mechanic create otherwise lands as a driver.
    // We correct it here (service_role is exempt from the role-change guard).
    // Skipped for driver — the trigger's default already matches, keeping the
    // existing /admin/drivers create flow byte-for-byte unchanged.
    //
    // admin_role_id: leaving it null resolves to FULL access — the opposite of
    // the restriction the owner asked for — so a failure here must not silently
    // mint a full-access admin. Both fields fail toward less privilege by
    // rolling the just-created auth user back so the owner can retry cleanly.
    const corePatch: Record<string, unknown> = {};
    if (role !== "driver") corePatch.role = role;
    if (adminRoleId) corePatch.admin_role_id = adminRoleId;
    if (Object.keys(corePatch).length > 0) {
      const corePatchResp = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(corePatch),
        },
      );
      if (!corePatchResp.ok) {
        const raw = await corePatchResp.text();
        const rolledBack = await deleteAuthUser(userId);
        return new Response(
          JSON.stringify({
            ok: false,
            error: `Could not finalize the new ${role}'s role/access: HTTP ${corePatchResp.status} — ${raw.slice(0, 200)}. ${
              rolledBack
                ? "The new user was rolled back; retry with the same email."
                : `WARNING: rollback of auth user ${userId} also failed — they exist but as a plain driver / full-access account. Fix or delete them via the Supabase dashboard / Settings → Users & roles.`
            }`,
          }),
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // Drivers side row is required for the driver to function. If the INSERT
    // fails we ROLL BACK the auth user — the admin can retry with the same
    // email cleanly. A half-created driver is far worse than no driver: the
    // auth user exists and can sign in, but /driver/* routes crash trying to
    // look up their drivers row.
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
          id: userId,
          license_number: licenseNumber,
          license_expiry: licenseExpiry,
          initials: initialsFromName(name),
        }),
      });
      if (!driverInsResp.ok) {
        const raw = await driverInsResp.text();
        // Roll back the auth user so the admin can retry with the same email.
        const rolledBack = await deleteAuthUser(userId);
        return new Response(
          JSON.stringify({
            ok: false,
            error: `Drivers row insert failed: HTTP ${driverInsResp.status} — ${raw.slice(0, 200)}. ${
              rolledBack
                ? "Auth user was rolled back; you can retry with the same email."
                : `WARNING: rollback of auth user ${userId} also failed. Manually delete via Supabase dashboard before retrying.`
            }`,
          }),
          { status: 500, headers: corsHeaders },
        );
      }
    }
  } else {
    // ---- Existing email → reassign instead of erroring --------------------
    // The admin re-submitted an email that already has an auth user. Rather
    // than hard-failing with "already registered", update that user to match
    // the submitted name / phone / role, reconcile their role side-row, and
    // re-issue their invite or credential. We NEVER delete the pre-existing
    // auth user on any failure in this branch — it's a real account.
    const raw = await adminUserResp.text();
    const isEmailExists =
      /email_exists/i.test(raw) || /already\s+(been\s+)?registered/i.test(raw);
    if (!isEmailExists) {
      return new Response(
        JSON.stringify({
          error: `auth admin createUser failed: HTTP ${adminUserResp.status} — ${raw.slice(0, 300)}`,
        }),
        { status: adminUserResp.status >= 500 ? 502 : 400, headers: corsHeaders },
      );
    }

    reassigned = true;

    // profiles.email is UNIQUE and the signup trigger always creates a
    // profiles row, so this is the reliable auth-user-id lookup. We also read
    // the target's current role/is_owner to gate the mutation below.
    const lookupResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,role,is_owner`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    const lookupRows = lookupResp.ok
      ? ((await lookupResp.json()) as Array<{ id: string; role?: string; is_owner?: boolean }>)
      : [];
    const existingId = Array.isArray(lookupRows) ? lookupRows[0]?.id : undefined;
    if (!existingId) {
      return new Response(
        JSON.stringify({
          error: `${email} is already registered but no matching profile row was found to reassign. Resolve the orphaned auth user in the Supabase dashboard.`,
        }),
        { status: 409, headers: corsHeaders },
      );
    }
    // Owner-only to touch an existing admin/owner. Without this, a restricted
    // (non-owner) admin could reassign an existing admin/owner's email to
    // role=driver/mechanic and, via the service-role PATCH below, clear their
    // is_owner + change their role — defeating the owner-only role-change
    // guard (which the edge fn bypasses by running as service_role). The
    // reassign-TO-admin gate above only covers the other direction.
    const targetIsAdminOrOwner =
      lookupRows[0]?.role === "admin" || lookupRows[0]?.is_owner === true;
    if (targetIsAdminOrOwner && !callerIsOwner) {
      return new Response(
        JSON.stringify({ error: "owner admin required to modify an admin or owner user" }),
        { status: 403, headers: corsHeaders },
      );
    }
    userId = existingId;

    // Update the auth user's role (app_metadata — the trustworthy source the
    // role guard honours) and display name. GoTrue admin update is a PUT and
    // shallow-merges app_metadata / user_metadata, so other keys survive.
    const metaResp = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          app_metadata: { role },
          user_metadata: { name },
        }),
      },
    );
    if (!metaResp.ok) {
      const rawM = await metaResp.text();
      return new Response(
        JSON.stringify({
          error: `Reassign failed updating auth metadata for ${email}: HTTP ${metaResp.status} — ${rawM.slice(0, 200)}`,
        }),
        { status: metaResp.status >= 500 ? 502 : 400, headers: corsHeaders },
      );
    }

    // Update the profiles row: name, role, phone (if provided), and
    // reactivate (a previously deactivated user is being re-onboarded).
    // service_role is exempt from the enforce_profile_role_change_admin_only
    // trigger, so changing role here is permitted.
    const profBody: Record<string, unknown> = { name, role, status: "active" };
    if (phone) profBody.phone = phone;
    if (role === "admin") {
      // Reassign-to-admin applies the form's access choice: a picked custom
      // role, or full access (null) when none was picked. Any per-user
      // override is left untouched — that's managed via the Access editor.
      profBody.admin_role_id = adminRoleId || null;
    } else {
      // Reassign away from admin: clear admin access flags so a later
      // re-promotion doesn't silently restore stale owner powers. The DB's
      // last-owner trigger still blocks demoting the final owner (it has no
      // service_role exemption) — that error surfaces to the caller.
      profBody.is_owner = false;
      profBody.admin_role_id = null;
      profBody.allowed_tabs_override = null;
    }
    const profPatch = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(profBody),
      },
    );
    if (!profPatch.ok) {
      const rawP = await profPatch.text();
      return new Response(
        JSON.stringify({
          error: `Reassign failed updating profile for ${email}: HTTP ${profPatch.status} — ${rawP.slice(0, 200)}`,
        }),
        { status: 400, headers: corsHeaders },
      );
    }

    // Reconcile the role-specific side row. Upsert on the primary key so it
    // works whether or not the row already existed (e.g. mechanic → driver).
    if (role === "driver") {
      const upsert = await fetch(`${SUPABASE_URL}/rest/v1/drivers?on_conflict=id`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          id: userId,
          license_number: licenseNumber,
          license_expiry: licenseExpiry,
          initials: initialsFromName(name),
        }),
      });
      if (!upsert.ok) {
        const rawD = await upsert.text();
        return new Response(
          JSON.stringify({
            error: `Reassign updated the profile but the drivers row failed: HTTP ${upsert.status} — ${rawD.slice(0, 200)}. The user's role is now driver but they have no license record; fix via /admin/drivers.`,
          }),
          { status: 500, headers: corsHeaders },
        );
      }
    } else if (role === "mechanic") {
      const upsert = await fetch(`${SUPABASE_URL}/rest/v1/mechanics?on_conflict=id`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ id: userId }),
      });
      if (!upsert.ok) {
        const rawMe = await upsert.text();
        return new Response(
          JSON.stringify({
            error: `Reassign updated the profile but the mechanics row failed: HTTP ${upsert.status} — ${rawMe.slice(0, 200)}.`,
          }),
          { status: 500, headers: corsHeaders },
        );
      }
    }

    // When not emailing an invite, reset the password so the admin has a
    // fresh credential to hand over (mirrors the create path's tempPassword).
    // When sendInviteEmail is true we leave the password alone — the recovery
    // link below lets the user set their own.
    if (!sendInviteEmail) {
      const pwResp = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ password: tempPassword }),
        },
      );
      if (!pwResp.ok) {
        const rawPw = await pwResp.text();
        return new Response(
          JSON.stringify({
            error: `Reassigned ${email} but could not reset the password: HTTP ${pwResp.status} — ${rawPw.slice(0, 200)}. Use the /login → Forgot? flow to send them a reset.`,
          }),
          { status: 500, headers: corsHeaders },
        );
      }
    }
  }

  // ---- Optional invite-email path
  // If the caller asked us to send an invite email, generate a recovery
  // link via the Supabase Auth Admin generate_link endpoint (type=recovery
  // because the user already has the email_confirm flag and a password
  // we generated — what they need is a one-time link to set their own).
  // Then fan out the email via Resend.
  //
  // We do NOT roll back the auth user on email failure — the user IS
  // created and can sign in with the temp password. We just surface a
  // warning so the admin can fall back to manual delivery.
  let inviteEmailSent = false;
  let inviteEmailError: string | null = null;
  // try/catch the whole block: at this point the auth user EXISTS, so any
  // uncaught throw (generate_link network error, non-JSON body, …) must
  // degrade to the warning path below — a bare 500 would make the admin
  // retry and hit "email already registered".
  if (sendInviteEmail) {
    try {
      const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
      const redirectTo = redirectToOverride || (siteUrl ? `${siteUrl}/reset-password` : "");

      const linkBody: Record<string, unknown> = {
        type: "recovery",
        email,
      };
      if (redirectTo) linkBody.redirect_to = redirectTo;
      const linkResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(linkBody),
      });
      if (!linkResp.ok) {
        const raw = await linkResp.text();
        inviteEmailError = `generate_link HTTP ${linkResp.status} — ${raw.slice(0, 200)}`;
      } else {
        const linkJson = (await linkResp.json()) as {
          action_link?: string;
          properties?: { action_link?: string };
        };
        const actionLink =
          linkJson.action_link ?? linkJson.properties?.action_link ?? "";
        if (!actionLink) {
          inviteEmailError = "generate_link returned no action_link";
        } else {
          const { subject, html, text } = buildInviteEmail({
            recipientName: name,
            recipientEmail: email,
            actionLink,
            orgName: Deno.env.get("ORG_NAME") ?? "Engage Hydrovac CRM",
          });
          const sendResult = await sendResendEmail(Deno.env, {
            to: email,
            subject,
            html,
            text,
          });
          if (!sendResult.ok) {
            inviteEmailError = sendResult.error;
          } else {
            inviteEmailSent = true;
          }
        }
      }
    } catch (err) {
      inviteEmailError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- Reassign fallback: make the fallback credential real.
  // On the reassign path the temp password is only applied to the pre-existing
  // user in the `!sendInviteEmail` reset block above. If we DID try to send an
  // invite but it failed, we're about to fall through to the tempPassword
  // response — but that password was never set on the account, so it would
  // authenticate nothing. Apply it now so the credential we hand back is valid.
  // (Fresh-create never needs this: the user was created WITH the temp
  // password at POST time.)
  if (reassigned && sendInviteEmail && !inviteEmailSent) {
    const pwResp = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: tempPassword }),
      },
    );
    if (!pwResp.ok) {
      // Both delivery mechanisms failed (invite email AND password reset). The
      // user's details/role WERE updated, but we can't hand over a working
      // credential — surface that honestly rather than returning a dead temp
      // password the admin would relay in vain.
      const rawPw = await pwResp.text();
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Reassigned ${email} (details/role updated) but could not deliver a credential: invite email failed (${inviteEmailError}) and the password reset also failed: HTTP ${pwResp.status} — ${rawPw.slice(0, 150)}. Use /login → Forgot? to send them a reset.`,
        }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  // Final response shape:
  //   - sendInviteEmail=false (or omitted): existing behavior, returns
  //     tempPassword for the admin to relay manually.
  //   - sendInviteEmail=true + email sent: returns inviteSent=true and OMITS
  //     tempPassword so the UI can render "Invite sent to X" instead.
  //   - sendInviteEmail=true + email failed: returns BOTH tempPassword AND
  //     a warning so the admin can fall back to manual delivery without
  //     blocking the flow. The auth user is created either way.
  const warnings = [phoneWarning, inviteEmailError ? `Invite email failed: ${inviteEmailError}. Fall back to sending the temp password manually.` : null].filter(
    (w): w is string => Boolean(w),
  );
  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;

  if (sendInviteEmail && inviteEmailSent) {
    return new Response(
      JSON.stringify({
        ok: true,
        userId,
        reassigned,
        inviteSent: true,
        ...(warning ? { warning } : {}),
        hint: reassigned
          ? `${email} already existed — updated their details/role and sent a fresh invite. They click the link to set their password.`
          : `Invite email sent to ${email}. User clicks the link to set their password.`,
      }),
      { status: 200, headers: corsHeaders },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      userId,
      reassigned,
      tempPassword,
      inviteSent: false,
      ...(warning ? { warning } : {}),
      hint: reassigned
        ? `${email} already existed — updated their details/role and reset their password. Send the new temp password; they can rotate it via the Forgot? link.`
        : "Send the temp password to the user. They should change it on first login via the Forgot? link.",
    }),
    { status: 200, headers: corsHeaders },
  );
});
