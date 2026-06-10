// Supabase Edge Function: qbo-list-employees
//
// Returns the active Employee list from the connected QuickBooks Online
// company so the admin can map drivers → QBO employees by NAME from a
// dropdown instead of hand-copying internal numeric IDs.
//
// Scope: this is the standard Accounting API `Employee` entity
// (com.intuit.quickbooks.accounting) — the SAME scope already authorized by
// the in-app Connect flow. It does NOT require the gated payroll scope, so
// it works today. (Pushing TimeActivity hours, also accounting-scope, is how
// hours reach QuickBooks Payroll: when payroll is run in QBO, an employee's
// time activities are pulled onto the paycheck.)
//
// Auth: admin user JWT or service_role bearer.
// Returns: { ok: true, env, employees: [{ id, name, active }] }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getQboAccessToken, qboApiHost } from "../_shared/qbo-oauth.ts";
import { verifyAdminOrServiceRole } from "../_shared/auth.ts";

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

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonOk({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return jsonOk({ error: "Missing supabase env" }, 500);
  }
  const authFailure = await verifyAdminOrServiceRole(req, {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    corsHeaders: cors,
  });
  if (authFailure) return authFailure;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let tok: { access_token: string; realm_id: string };
  try {
    tok = await getQboAccessToken(admin, Deno.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonOk(
      {
        ok: false,
        error: `Could not get a QuickBooks token: ${msg}`,
        hint: "Connect QuickBooks first under Settings → Integrations.",
      },
      502,
    );
  }
  if (!tok.realm_id) {
    return jsonOk(
      { ok: false, error: "No realm_id stored — reconnect QuickBooks." },
      400,
    );
  }

  const host = qboApiHost(Deno.env);
  const env = Deno.env.get("QBO_ENVIRONMENT") ?? "sandbox";
  // Active employees, capped — fleets have tens, not thousands. Ordered so
  // the dropdown is alphabetical.
  const query = encodeURIComponent(
    "select Id, DisplayName, GivenName, FamilyName, Active from Employee where Active = true order by DisplayName MAXRESULTS 200",
  );
  let res: Response;
  try {
    res = await fetch(
      `${host}/v3/company/${tok.realm_id}/query?query=${query}&minorversion=75`,
      {
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          Accept: "application/json",
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonOk({ ok: false, error: `Network error reaching QuickBooks: ${msg}` }, 502);
  }

  const text = await res.text();
  if (!res.ok) {
    return jsonOk(
      {
        ok: false,
        error: `QuickBooks Employee query failed (HTTP ${res.status})`,
        detail: text.slice(0, 400),
        hint:
          res.status === 401
            ? "QBO_ENVIRONMENT may not match the realm you connected (sandbox vs production)."
            : undefined,
      },
      502,
    );
  }

  let body: {
    QueryResponse?: {
      Employee?: Array<{
        Id?: string;
        DisplayName?: string;
        GivenName?: string;
        FamilyName?: string;
        Active?: boolean;
      }>;
    };
  };
  try {
    body = JSON.parse(text);
  } catch {
    return jsonOk({ ok: false, error: "QuickBooks returned non-JSON", detail: text.slice(0, 300) }, 502);
  }

  const employees = (body.QueryResponse?.Employee ?? []).map((e) => {
    const fallback = `${e.GivenName ?? ""} ${e.FamilyName ?? ""}`.trim();
    return {
      id: e.Id ?? "",
      name: e.DisplayName || fallback || `Employee ${e.Id ?? ""}`,
      active: e.Active !== false,
    };
  }).filter((e) => e.id);

  return jsonOk({ ok: true, env, count: employees.length, employees });
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("qbo-list-employees: UNHANDLED", msg, err instanceof Error ? err.stack : "");
    return jsonOk({ ok: false, error: msg }, 500);
  }
});
