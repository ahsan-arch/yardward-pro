// Supabase Edge Function: portal-weekly-digest
//
// Weekly per-client dump report (replaces Formstack's scheduled Monday
// exports): for every client with hauling records in the last 7 days AND at
// least one email recipient, send a digest table of the week's loads plus
// their prepaid-ticket balance.
//
// Invoked by pg_cron every Monday (see the weekly_digest_cron migration) with
// the service-role key, or manually by an admin (e.g. a "Send now" button
// later). Body: { sinceDays?: number, dryRun?: boolean }.
//
// Recipients per client = portal_notify_emails ∪ tickets_report_recipients.
// Clients with no recipients or no records that week are skipped (no spam).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAdminOrServiceRole } from "../_shared/auth.ts";
import { sendResendEmail, buildWeeklyDigestEmail } from "../_shared/email.ts";

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

  let body: { sinceDays?: number; dryRun?: boolean } = {};
  try {
    body = req.body ? await req.json() : {};
  } catch {
    /* empty body is fine */
  }
  const sinceDays = Math.min(Math.max(body.sinceDays ?? 7, 1), 31);
  const dryRun = body.dryRun === true;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const toIso = new Date().toISOString();
  const fromIso = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data: clients, error: cliErr } = await admin
    .from("clients")
    .select(
      "id, name, portal_notify_emails, tickets_report_recipients, tickets_enabled, tickets_balance",
    )
    .eq("status", "active");
  if (cliErr) return jsonOk({ ok: false, error: cliErr.message }, 500);

  const results: Array<{ clientId: string; clientName: string; loads: number; sent: boolean; reason?: string }> = [];

  for (const c of clients ?? []) {
    const recipients = Array.from(
      new Set([
        ...((c.portal_notify_emails as string[]) ?? []),
        ...((c.tickets_report_recipients as string[]) ?? []),
      ]),
    ).filter(Boolean);
    const base = { clientId: c.id as string, clientName: c.name as string };
    if (recipients.length === 0) {
      results.push({ ...base, loads: 0, sent: false, reason: "no recipients" });
      continue;
    }

    const { data: rows, error: rowErr } = await admin
      .from("dump_logs")
      .select("submission_code, logged_at, submitted_name, truck_number, load_type, quantity, weight, status")
      .eq("client_id", c.id)
      .gte("logged_at", fromIso)
      .order("logged_at", { ascending: true })
      .limit(1000);
    if (rowErr) {
      results.push({ ...base, loads: 0, sent: false, reason: `query failed: ${rowErr.message}` });
      continue;
    }
    if (!rows || rows.length === 0) {
      results.push({ ...base, loads: 0, sent: false, reason: "no loads this period" });
      continue;
    }

    const mail = buildWeeklyDigestEmail({
      clientName: c.name as string,
      fromIso,
      toIso,
      rows: rows.map((r) => ({
        code: (r.submission_code as string) ?? "",
        loggedAt: (r.logged_at as string) ?? "",
        driver: (r.submitted_name as string) ?? "",
        truck: (r.truck_number as string) ?? "",
        load: (r.load_type as string) ?? "",
        qty: (r.quantity as string) ?? "",
        weight: (r.weight as string) ?? "",
        status: (r.status as string) ?? "",
      })),
      ticketsBalance: c.tickets_enabled ? ((c.tickets_balance as number) ?? null) : null,
    });

    if (dryRun) {
      results.push({ ...base, loads: rows.length, sent: false, reason: "dry run" });
      continue;
    }
    const sent = await sendResendEmail(Deno.env, {
      to: recipients,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    results.push({
      ...base,
      loads: rows.length,
      sent: sent.ok,
      ...(sent.ok ? {} : { reason: sent.error }),
    });
  }

  const emailed = results.filter((r) => r.sent).length;
  console.log(`portal-weekly-digest: emailed ${emailed}/${results.length} clients`);
  return jsonOk({ ok: true, dryRun, fromIso, toIso, emailed, results });
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("portal-weekly-digest: UNHANDLED", msg, err instanceof Error ? err.stack : "");
    return jsonOk({ ok: false, error: msg }, 500);
  }
});
