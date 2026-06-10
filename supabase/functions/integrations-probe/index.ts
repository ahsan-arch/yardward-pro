// integrations-probe — single endpoint that returns the live health status of
// every external integration the app talks to (Twilio, Geotab, QBO, Fleetio).
//
// Why this exists: the Admin → Settings → Integrations tab used to render a
// hardcoded array of {Connected, Disconnected} badges with literal strings
// like "Last sync: 2 min ago". That UI lied to operators — it showed
// "Geotab Connected" regardless of whether GEOTAB_USERNAME was actually set
// or whether the credential still worked. This function replaces those
// hardcoded values with real probes:
//
//   - configured   = environment variables required by the integration are set
//   - reachable    = a live probe call (auth handshake / minimal API ping)
//                    actually got a 2xx back
//   - lastError    = most recent failure message from integration_alerts,
//                    if any (helps operator triage)
//   - rawProbeMsg  = short human-readable status line for the badge subtitle
//
// Each integration probes in isolation so a Geotab outage doesn't poison the
// Twilio result. We use Promise.allSettled rather than Promise.all for that.
//
// Auth: admin-only. Pattern matches the other admin-* and twilio-verify
// functions in this directory.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

type IntegrationStatus = {
  name: string;
  desc: string;
  configured: boolean;
  reachable: boolean | null; // null when we can't even attempt a probe
  rawProbeMsg: string; // short human-readable line for the badge subtitle
  lastError: string | null; // from integration_alerts, if any
  checkedAt: string;
};

// ----------------------------------------------------------------------------
// Per-integration probes. Each returns the partial IntegrationStatus shape;
// the outer handler fills in name/desc/checkedAt.
// ----------------------------------------------------------------------------

async function probeTwilio(): Promise<Omit<IntegrationStatus, "name" | "desc" | "checkedAt">> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
  const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const from = Deno.env.get("TWILIO_FROM_NUMBER") ?? "";
  if (!sid || !token) {
    return {
      configured: false,
      reachable: null,
      rawProbeMsg: "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN not set",
      lastError: null,
    };
  }
  // Probe: fetch the account itself. Cheapest call that proves the credential
  // works AND that Twilio's API is up.
  try {
    const auth = btoa(`${sid}:${token}`);
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: `Auth check failed (HTTP ${resp.status})`,
        lastError: body.slice(0, 200),
      };
    }
    const acct = (await resp.json()) as { status?: string; friendly_name?: string };
    const fromNote = from ? "" : " — TWILIO_FROM_NUMBER not set, outbound SMS disabled";
    return {
      configured: true,
      reachable: true,
      rawProbeMsg: `Account ${acct.friendly_name ?? sid.slice(-6)} (${acct.status ?? "active"})${fromNote}`,
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      rawProbeMsg: "Network error reaching Twilio",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeGeotab(): Promise<Omit<IntegrationStatus, "name" | "desc" | "checkedAt">> {
  const u = Deno.env.get("GEOTAB_USERNAME") ?? "";
  const p = Deno.env.get("GEOTAB_PASSWORD") ?? "";
  const db = Deno.env.get("GEOTAB_DATABASE") ?? "";
  if (!u || !p || !db) {
    return {
      configured: false,
      reachable: null,
      rawProbeMsg: "GEOTAB_USERNAME / GEOTAB_PASSWORD / GEOTAB_DATABASE not set",
      lastError: null,
    };
  }
  // Probe: Authenticate against the Geotab MyGeotab JSON-RPC. Returns a
  // session credential blob; we don't need it for anything, just proves
  // the credential works.
  try {
    const resp = await fetch("https://my.geotab.com/apiv1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "Authenticate",
        params: { userName: u, password: p, database: db },
      }),
    });
    if (!resp.ok) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: `Auth check failed (HTTP ${resp.status})`,
        lastError: null,
      };
    }
    const body = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: `Geotab rejected credentials`,
        lastError: body.error.message ?? "unknown",
      };
    }
    return {
      configured: true,
      reachable: true,
      rawProbeMsg: `Auth OK on database "${db}"`,
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      rawProbeMsg: "Network error reaching Geotab",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeQbo(): Promise<Omit<IntegrationStatus, "name" | "desc" | "checkedAt">> {
  const cid = Deno.env.get("QBO_CLIENT_ID") ?? "";
  const cs = Deno.env.get("QBO_CLIENT_SECRET") ?? "";
  const env = Deno.env.get("QBO_ENVIRONMENT") ?? "";
  if (!cid || !cs) {
    return {
      configured: false,
      reachable: null,
      rawProbeMsg: "QBO_CLIENT_ID + QBO_CLIENT_SECRET not set",
      lastError: null,
    };
  }
  // Look for a stored OAuth token row — if none exists, the admin hasn't
  // completed the OAuth handshake yet. Reachable=null here means "configured
  // for OAuth but no user has connected their QBO company yet".
  //
  // What "connected" actually means: the REFRESH token (valid ~100 days,
  // renewed every time it's used). The access token only lives 60 minutes
  // and is re-minted automatically by getQboAccessToken on every QBO call —
  // an expired (or deliberately NULLed post-connect) access token is the
  // NORMAL steady state, not a failure. The probe therefore keys on
  // refresh_token presence + how long ago it was last used (updated_at),
  // and only goes red when Intuit's 100-days-idle expiry is in play.
  try {
    const tokResp = await fetch(
      `${SUPABASE_URL}/rest/v1/qbo_oauth_tokens?select=id,refresh_token,access_token_expires_at,updated_at&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!tokResp.ok) {
      const raw = await tokResp.text();
      return {
        configured: true,
        reachable: null,
        rawProbeMsg: `Couldn't read qbo_oauth_tokens (HTTP ${tokResp.status})`,
        lastError: raw.slice(0, 200),
      };
    }
    const rows = (await tokResp.json()) as Array<{
      id: string;
      refresh_token: string | null;
      access_token_expires_at: string | null;
      updated_at: string | null;
    }>;
    if (rows.length === 0) {
      return {
        configured: true,
        reachable: null,
        rawProbeMsg: `${env || "sandbox"} mode — no QBO company connected yet (Connect to authorize)`,
        lastError: null,
      };
    }
    const r = rows[0];
    if (!r.refresh_token) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: "OAuth row exists but holds no refresh token — re-authorize via Connect",
        lastError: "refresh_token is null",
      };
    }
    // Intuit expires refresh tokens after ~100 days without use. updated_at
    // moves every time the shared helper rotates the token, so it doubles as
    // "last successful use". Warn from day 90 to leave headroom.
    const lastUsedMs = r.updated_at ? new Date(r.updated_at).getTime() : NaN;
    const daysSinceUse = Number.isFinite(lastUsedMs)
      ? Math.floor((Date.now() - lastUsedMs) / 86_400_000)
      : null;
    if (daysSinceUse !== null && daysSinceUse >= 90) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: `Refresh token last used ${daysSinceUse} days ago — Intuit expires them after ~100 idle days. Reconnect soon.`,
        lastError: "refresh token near idle expiry",
      };
    }
    const accessValid =
      !!r.access_token_expires_at &&
      new Date(r.access_token_expires_at).getTime() > Date.now();
    return {
      configured: true,
      reachable: true,
      rawProbeMsg: accessValid
        ? `Authorized (${env || "sandbox"}) — access token valid until ${r.access_token_expires_at!.slice(0, 19)}Z`
        : `Authorized (${env || "sandbox"}) — access token auto-renews on next QBO call`,
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: null,
      rawProbeMsg: "Couldn't reach Supabase to check QBO token",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeFleetio(): Promise<Omit<IntegrationStatus, "name" | "desc" | "checkedAt">> {
  const token = Deno.env.get("FLEETIO_BEARER_TOKEN") ?? "";
  const acct = Deno.env.get("FLEETIO_ACCOUNT_TOKEN") ?? "";
  if (!token) {
    return {
      configured: false,
      reachable: null,
      rawProbeMsg: "FLEETIO_BEARER_TOKEN not set (one-time vehicle import is unavailable)",
      lastError: null,
    };
  }
  // Probe: lightest read endpoint Fleetio exposes. per_page minimum is 2 —
  // per_page=1 gets HTTP 400 {"errors":{"per_page":["out of range"]}} and
  // would show "Auth check failed" even with valid keys.
  try {
    const resp = await fetch("https://secure.fleetio.com/api/v1/vehicles?per_page=2", {
      headers: {
        Authorization: `Token token=${token}`,
        ...(acct ? { "Account-Token": acct } : {}),
      },
    });
    if (!resp.ok) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg: `Auth check failed (HTTP ${resp.status})`,
        lastError: null,
      };
    }
    return {
      configured: true,
      reachable: true,
      rawProbeMsg: "Auth OK — ready for one-time import",
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      rawProbeMsg: "Network error reaching Fleetio",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeFormstack(): Promise<Omit<IntegrationStatus, "name" | "desc" | "checkedAt">> {
  const token = Deno.env.get("FORMSTACK_ACCESS_TOKEN") ?? "";
  if (!token) {
    return {
      configured: false,
      reachable: null,
      rawProbeMsg: "FORMSTACK_ACCESS_TOKEN not set (generate a Personal Access Token in admin.formstack.com)",
      lastError: null,
    };
  }
  // Probe: list forms via the v2025 API (PATs only work there — the legacy
  // /api/v2 endpoints 401 them). pageSize minimum is >1 (pageSize=1 gets
  // HTTP 400, same trap as Fleetio's per_page) — 10 is verified working.
  try {
    const resp = await fetch(
      "https://www.formstack.com/api/v2025/forms?pageNumber=1&pageSize=10",
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!resp.ok) {
      return {
        configured: true,
        reachable: false,
        rawProbeMsg:
          resp.status === 401
            ? "Auth check failed (HTTP 401) — PAT expired or revoked; PATs live 30/60/90 days, regenerate in admin.formstack.com"
            : `Auth check failed (HTTP ${resp.status})`,
        lastError: null,
      };
    }
    const json = (await resp.json()) as { page?: { totalElements?: number } };
    const total = json.page?.totalElements;
    return {
      configured: true,
      reachable: true,
      rawProbeMsg: `Auth OK${typeof total === "number" ? ` — ${total} forms visible` : ""}`,
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      rawProbeMsg: "Network error reaching Formstack",
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ----------------------------------------------------------------------------
// Surface recent failure history per integration. integration_alerts is a
// shared write target across the qbo-* / geotab-* / twilio-* edge functions.
// We look back 24h and surface the most-recent error per integration as a
// "lastError" hint — admin can click through to /admin/errors for more.
// ----------------------------------------------------------------------------

async function recentAlertsByIntegration(): Promise<Record<string, string>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/integration_alerts?created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&select=integration,message,created_at`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!resp.ok) return {};
    const rows = (await resp.json()) as Array<{
      integration: string;
      message: string;
      created_at: string;
    }>;
    // Most recent per integration only.
    const byName: Record<string, string> = {};
    for (const row of rows) {
      if (byName[row.integration]) continue;
      byName[row.integration] = row.message;
    }
    return byName;
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ---- admin auth gate (same shape as the other admin-* functions)
  try {
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      return new Response(JSON.stringify({ error: "missing bearer token" }), {
        status: 401,
        headers: corsHeaders,
      });
    }
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
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "auth failed" }),
      { status: 500, headers: corsHeaders },
    );
  }

  // ---- run all 4 probes + the alerts query in parallel. allSettled so that
  // a single probe throwing doesn't tank the whole response — the operator
  // wants to see which integrations are up even when one is melting down.
  const checkedAt = new Date().toISOString();
  const [twilio, geotab, qbo, fleetio, formstack, alerts] = await Promise.all([
    probeTwilio().catch((e) => ({
      configured: false,
      reachable: false,
      rawProbeMsg: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      lastError: null,
    })),
    probeGeotab().catch((e) => ({
      configured: false,
      reachable: false,
      rawProbeMsg: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      lastError: null,
    })),
    probeQbo().catch((e) => ({
      configured: false,
      reachable: false,
      rawProbeMsg: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      lastError: null,
    })),
    probeFleetio().catch((e) => ({
      configured: false,
      reachable: false,
      rawProbeMsg: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      lastError: null,
    })),
    probeFormstack().catch((e) => ({
      configured: false,
      reachable: false,
      rawProbeMsg: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
      lastError: null,
    })),
    recentAlertsByIntegration(),
  ]);

  const integrations: IntegrationStatus[] = [
    {
      name: "Twilio",
      desc: "SMS notifications + driver/mechanic Communications",
      ...twilio,
      lastError: twilio.lastError ?? alerts["twilio"] ?? null,
      checkedAt,
    },
    {
      name: "Geotab",
      desc: "GPS + telematics + timesheet cross-reference",
      ...geotab,
      lastError: geotab.lastError ?? alerts["geotab"] ?? null,
      checkedAt,
    },
    {
      name: "QuickBooks Online",
      desc: "Invoice + payroll sync",
      ...qbo,
      lastError: qbo.lastError ?? alerts["qbo"] ?? null,
      checkedAt,
    },
    {
      name: "Fleetio",
      desc: "One-time vehicle data migration",
      ...fleetio,
      lastError: fleetio.lastError ?? alerts["fleetio"] ?? null,
      checkedAt,
    },
    {
      name: "Formstack",
      desc: "Hauling record / dump form submissions",
      ...formstack,
      lastError: formstack.lastError ?? alerts["formstack"] ?? null,
      checkedAt,
    },
  ];

  return new Response(JSON.stringify({ ok: true, integrations, checkedAt }), {
    status: 200,
    headers: corsHeaders,
  });
});
