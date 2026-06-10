// Supabase Edge Function: client-portal
//
// Public-facing API for the client dump-form portal (Formstack replacement
// Phase 1). Access is gated by a per-employee portal code, NOT a user JWT —
// the SPA calls this with the anon key and the code in the body.
//
// Actions (POST {action, code, ...}):
//   context — validate code, return the client's form context
//             { clientName, driverNames, truckNumbers }
//   submit  — validate code + required fields, insert dump_logs row with a
//             human-quotable unique submission code, return { submissionCode }
//
// Security model: codes are unguessable (slug + 6 random base32 chars),
// revocable per employee, scoped to one client's form. The function never
// returns other clients' data; a revoked/unknown code gets a uniform 401.
// Writes happen with service_role (RLS on the tables is admin-only).
//
// Phase 2 will add the on-submit fan-out here (Twilio SMS to yard/gate,
// Resend email to the receiving facility) — keeping submission and
// notification in one place is the point of routing through this function.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTwilioSms } from "../_shared/twilio.ts";
import {
  sendResendEmail,
  buildDumpFormEmail,
  buildTicketLowBalanceEmail,
} from "../_shared/email.ts";

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

interface SubmitInput {
  driverName?: string;
  truckNumber?: string;
  loadType?: string;
  quantity?: string;
  weight?: string;
  location?: string;
  receivingSite?: string;
  notes?: string;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

interface Body {
  action?: "context" | "submit";
  code?: string;
  submission?: SubmitInput;
}

function randomSuffix(len = 4): string {
  // Crockford-ish base32 — no 0/O/1/I confusion when quoted over the phone.
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join("");
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonOk({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonOk({ error: "Missing supabase env" }, 500);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonOk({ error: "Body must be JSON" }, 400);
  }
  const code = (body.code ?? "").trim();
  if (!code || code.length < 6 || code.length > 80) {
    return jsonOk({ ok: false, error: "Invalid or revoked access code" }, 401);
  }

  // ---- Resolve + validate the portal token --------------------------------
  const { data: token, error: tokErr } = await admin
    .from("client_portal_tokens")
    .select("id, client_id, revoked_at, use_count")
    .eq("code", code)
    .maybeSingle();
  if (tokErr) {
    console.error("client-portal: token lookup failed", tokErr.message);
    return jsonOk({ ok: false, error: "Lookup failed — try again" }, 500);
  }
  if (!token || token.revoked_at) {
    // Uniform message for unknown vs revoked — don't leak which.
    return jsonOk({ ok: false, error: "Invalid or revoked access code" }, 401);
  }

  const { data: client, error: cliErr } = await admin
    .from("clients")
    .select(
      "id, name, portal_driver_names, portal_truck_numbers, portal_notify_sms, portal_notify_emails, tickets_report_recipients, status",
    )
    .eq("id", token.client_id)
    .maybeSingle();
  if (cliErr || !client) {
    console.error("client-portal: client lookup failed", cliErr?.message);
    return jsonOk({ ok: false, error: "Client not found" }, 500);
  }
  if (client.status === "inactive") {
    return jsonOk({ ok: false, error: "This account is inactive — contact EHS" }, 403);
  }

  // Touch usage telemetry (fire-and-forget; failure must not block the user).
  // use_count increments only on submit (below) — last_used_at moves on any
  // valid use, including just opening the form.
  void admin
    .from("client_portal_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", token.id)
    .then(() => {});

  if (body.action === "context") {
    return jsonOk({
      ok: true,
      clientName: client.name,
      driverNames: client.portal_driver_names ?? [],
      truckNumbers: client.portal_truck_numbers ?? [],
    });
  }

  if (body.action === "submit") {
    const s = body.submission ?? {};
    const driverName = (s.driverName ?? "").trim();
    const truckNumber = (s.truckNumber ?? "").trim();
    const loadType = (s.loadType ?? "").trim();
    const quantity = (s.quantity ?? "").trim();
    const weight = (s.weight ?? "").trim();
    const location = (s.location ?? "").trim();
    const receivingSite = (s.receivingSite ?? "").trim();
    const notes = (s.notes ?? "").trim();

    // Server-side enforcement of the "form will not submit without required
    // sections" rule — the SPA validates too, but regulation compliance
    // can't rest on client-side JS.
    const missing: string[] = [];
    if (!driverName) missing.push("driverName");
    if (!truckNumber) missing.push("truckNumber");
    if (!loadType) missing.push("loadType");
    if (!location) missing.push("location");
    if (!quantity && !weight) missing.push("quantity or weight");
    if (missing.length > 0) {
      return jsonOk({ ok: false, error: `Required fields missing: ${missing.join(", ")}` }, 400);
    }

    // Human-quotable unique code: <CLIENTPREFIX>-<YYYYMMDD>-<4 chars>.
    const prefix = (client.name as string)
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 6)
      .toUpperCase() || "EHS";
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");

    // Retry on the (astronomically unlikely) code collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      const submissionCode = `${prefix}-${today}-${randomSuffix(4)}`;
      const dumpLogId = `DL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const submittedAtIso = new Date().toISOString();
      const { error: insErr } = await admin.from("dump_logs").insert({
        id: dumpLogId,
        driver_id: null,
        client_id: client.id,
        submission_code: submissionCode,
        source: "client-portal",
        portal_token_id: token.id,
        submitted_name: driverName,
        truck_number: truckNumber,
        load_type: loadType,
        quantity,
        weight,
        location,
        receiving_site: receivingSite,
        notes,
        gps_lat: typeof s.gpsLat === "number" ? s.gpsLat : null,
        gps_lng: typeof s.gpsLng === "number" ? s.gpsLng : null,
        status: "submitted",
        logged_at: submittedAtIso,
      });
      if (insErr) {
        if (insErr.code === "23505") continue; // collision — regenerate
        console.error("client-portal: insert failed", insErr.message);
        return jsonOk({ ok: false, error: `Could not save submission: ${insErr.message}` }, 500);
      }

      // Telemetry only — a lost increment under concurrent submits is fine.
      void admin
        .from("client_portal_tokens")
        .update({ use_count: ((token.use_count as number) ?? 0) + 1 })
        .eq("id", token.id)
        .then(() => {});

      // ---- Phase 2 fan-out -------------------------------------------------
      // The submission is durable at this point; NOTHING below may fail it.
      // Each step degrades to a warning the caller can surface.
      const warnings: string[] = [];

      // 1. Prepaid-ticket debit (only when the client has tickets enabled).
      let ticketsRemaining: number | null = null;
      let ticketsThreshold: number | null = null;
      let ticketsEnabled = false;
      try {
        const { data: debit, error: debErr } = await admin.rpc("portal_debit_ticket", {
          p_client_id: client.id,
          p_dump_log_id: dumpLogId,
          p_dump_site: receivingSite || location,
          p_truck: truckNumber,
        });
        const row = Array.isArray(debit) ? debit[0] : debit;
        if (debErr) {
          warnings.push(`ticket debit failed: ${debErr.message}`);
        } else if (row?.ok && row.enabled) {
          ticketsEnabled = true;
          ticketsRemaining = row.new_balance as number;
          ticketsThreshold = row.threshold as number;
        }
      } catch (err) {
        warnings.push(
          `ticket debit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 2. Notification recipients: internal (app_settings) + per-client.
      let internalSms: string[] = [];
      let internalEmails: string[] = [];
      try {
        const { data: settings } = await admin
          .from("app_settings")
          .select("portal_notify_sms, portal_notify_emails")
          .eq("id", "default")
          .maybeSingle();
        internalSms = (settings?.portal_notify_sms as string[]) ?? [];
        internalEmails = (settings?.portal_notify_emails as string[]) ?? [];
      } catch {
        warnings.push("could not load internal notification recipients");
      }
      const clientSms = (client.portal_notify_sms as string[]) ?? [];
      const clientEmails = (client.portal_notify_emails as string[]) ?? [];
      const smsTargets = Array.from(new Set([...internalSms, ...clientSms])).filter(Boolean);
      const emailTargets = Array.from(new Set([...internalEmails, ...clientEmails])).filter(
        Boolean,
      );

      // 3. SMS fan-out — short gate-guard message, logged to sms_logs.
      if (smsTargets.length > 0) {
        const when = new Date().toLocaleTimeString("en-CA", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Toronto",
        });
        const smsBody =
          `${submissionCode} · ${client.name} · ${driverName} · truck ${truckNumber} · ` +
          `${loadType}${quantity ? ` ${quantity}` : ""} · ${when}` +
          (ticketsEnabled && ticketsRemaining != null
            ? ` · ${ticketsRemaining} tickets left`
            : "");
        for (const to of smsTargets) {
          const r = await sendTwilioSms(Deno.env, to, smsBody);
          if (!r.ok) warnings.push(`SMS to ${to} failed: ${r.error}`);
          void admin
            .from("sms_logs")
            .insert({
              id: `SMS-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
              driver_id: null,
              job_id: null,
              body: smsBody,
              twilio_message_id: r.twilioMessageId ?? null,
              delivery_status: r.ok ? "sent" : "failed",
            })
            .then(() => {});
        }
      }

      // 4. Email copy of the completed form (regulatory: receiving facility
      //    must have it before the truck leaves site).
      if (emailTargets.length > 0) {
        const mail = buildDumpFormEmail({
          submissionCode,
          clientName: client.name as string,
          driverName,
          truckNumber,
          loadType,
          quantity,
          weight,
          location,
          receivingSite,
          notes,
          gpsLat: typeof s.gpsLat === "number" ? s.gpsLat : null,
          gpsLng: typeof s.gpsLng === "number" ? s.gpsLng : null,
          submittedAtIso,
          ticketsRemaining: ticketsEnabled ? ticketsRemaining : null,
        });
        const sent = await sendResendEmail(Deno.env, {
          to: emailTargets,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
        if (!sent.ok) warnings.push(`form-copy email failed: ${sent.error}`);
      }

      // 5. Low-balance alert — fires only when this debit CROSSES the
      //    threshold (balance was above, now at/below) so clients get one
      //    alert, not one per dump while low.
      if (
        ticketsEnabled &&
        ticketsRemaining != null &&
        ticketsThreshold != null &&
        ticketsRemaining <= ticketsThreshold &&
        ticketsRemaining + 1 > ticketsThreshold
      ) {
        const reportRecipients = (client.tickets_report_recipients as string[]) ?? [];
        const lowTargets = Array.from(
          new Set([...emailTargets, ...reportRecipients]),
        ).filter(Boolean);
        if (lowTargets.length > 0) {
          const alert = buildTicketLowBalanceEmail({
            clientName: client.name as string,
            remaining: ticketsRemaining,
            threshold: ticketsThreshold,
          });
          const sent = await sendResendEmail(Deno.env, {
            to: lowTargets,
            subject: alert.subject,
            html: alert.html,
            text: alert.text,
          });
          if (!sent.ok) warnings.push(`low-balance email failed: ${sent.error}`);
        }
      }

      if (warnings.length > 0) {
        console.warn(`client-portal: ${submissionCode} fan-out warnings:`, warnings.join(" | "));
      }
      return jsonOk({
        ok: true,
        submissionCode,
        ...(ticketsEnabled ? { ticketsRemaining } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    }
    return jsonOk({ ok: false, error: "Could not allocate a submission code — try again" }, 500);
  }

  return jsonOk({ ok: false, error: "Unknown action" }, 400);
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("client-portal: UNHANDLED exception", msg, err instanceof Error ? err.stack : "");
    return jsonOk({ ok: false, error: msg }, 500);
  }
});
