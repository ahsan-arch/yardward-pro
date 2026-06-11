// Shared Resend email helper used by send-email (generic transactional) and
// admin-create-user (invite-email path). Single source of truth for:
//   - reading RESEND_API_KEY + RESEND_FROM_DEFAULT from env
//   - same-domain check on `from` override (Resend hard-rejects unverified
//     senders with 403, so we gate this client-side to surface an actionable
//     error rather than a generic 502)
//   - the actual POST to https://api.resend.com/emails
//
// Edge functions can't share runtime modules at deploy time — each function
// is bundled separately — but they CAN import from supabase/functions/_shared
// which the CLI rolls into every deploy. That's the pattern qbo-oauth uses,
// and it's the only way to avoid duplicating this logic per caller.

// deno-lint-ignore-file no-explicit-any

export interface ResendEmailPayload {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
}

export type ResendEmailResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; error: string; errorName?: string | null };

export async function sendResendEmail(
  env: { get: (k: string) => string | undefined },
  payload: ResendEmailPayload,
): Promise<ResendEmailResult> {
  const apiKey = env.get("RESEND_API_KEY") ?? "";
  const fromDefault = env.get("RESEND_FROM_DEFAULT") ?? "";
  if (!apiKey) {
    return {
      ok: false,
      status: 500,
      error:
        "RESEND_API_KEY not set — sign up at resend.com, verify the sender domain, create an API key, then run `supabase secrets set RESEND_API_KEY=re_...`",
    };
  }
  if (!fromDefault) {
    return {
      ok: false,
      status: 500,
      error:
        'RESEND_FROM_DEFAULT not set — should be the verified-domain sender like "Engage Hydrovac CRM <noreply@yardward.pro>"',
    };
  }

  const from = (payload.from ?? fromDefault).trim();
  // Extract the @domain portion of "Name <addr@domain>" or "addr@domain".
  const extractDomain = (addr: string): string =>
    addr.match(/@([^>\s]+)/)?.[1]?.toLowerCase() ?? "";
  const fromDomain = extractDomain(from);
  const defaultDomain = extractDomain(fromDefault);
  if (fromDomain && defaultDomain && fromDomain !== defaultDomain) {
    return {
      ok: false,
      status: 400,
      error: `from override (${fromDomain}) does not match verified domain (${defaultDomain}) — Resend would reject with 403`,
    };
  }

  const resendPayload: Record<string, unknown> = {
    from,
    to: Array.isArray(payload.to) ? payload.to : [payload.to],
    subject: payload.subject,
  };
  if (payload.html) resendPayload.html = payload.html;
  if (payload.text) resendPayload.text = payload.text;
  if (payload.replyTo) resendPayload.reply_to = payload.replyTo;
  if (payload.cc) resendPayload.cc = Array.isArray(payload.cc) ? payload.cc : [payload.cc];
  if (payload.bcc) resendPayload.bcc = Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc];

  // Never throw out of this helper — admin-create-user calls it AFTER the
  // auth user is created, and an uncaught network error there would turn a
  // successful creation into a bare 500 (admin retries → "email already
  // registered"). status 0 keeps it in the caller's 502/outage bucket.
  let resp: Response;
  try {
    resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resendPayload),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: `Network error reaching Resend: ${msg}` };
  }
  const text = await resp.text();
  let json: { id?: string; name?: string; message?: string } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body — leave null and fall back to text */
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: json?.message ?? text.slice(0, 500),
      errorName: json?.name ?? null,
    };
  }
  return { ok: true, id: json?.id ?? null };
}

// HTML escape — used by the invite template so a user-supplied name like
// `<script>alert(1)</script>` can't break out of the surrounding markup.
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Default invite-email template. Single-template approach keeps brand
// consistency without forcing a per-call template literal. The `actionLink`
// is the Supabase-generated recovery/invite link the recipient clicks to
// set their own password. `expiresAt` is a human-readable hint (Supabase
// links default to ~24h validity but we don't enforce it client-side).
export interface InviteEmailParams {
  recipientName: string;
  recipientEmail: string;
  actionLink: string;
  inviterName?: string;
  orgName?: string;
}

// Dump-form copy sent to the receiving facility / client contacts on every
// portal submission (regulatory requirement: the truck can't leave site
// until the receiving facility has a copy of the completed form).
export interface DumpFormEmailParams {
  submissionCode: string;
  clientName: string;
  driverName: string;
  truckNumber: string;
  loadType: string;
  quantity: string;
  weight: string;
  location: string;
  receivingSite: string;
  notes: string;
  gpsLat: number | null;
  gpsLng: number | null;
  submittedAtIso: string;
  ticketsRemaining?: number | null;
}

export function buildDumpFormEmail(p: DumpFormEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Dump form ${p.submissionCode} — ${p.clientName} · truck ${p.truckNumber}`;
  const when = p.submittedAtIso.replace("T", " ").slice(0, 16) + " UTC";
  const mapsUrl =
    p.gpsLat != null && p.gpsLng != null
      ? `https://maps.google.com/?q=${p.gpsLat},${p.gpsLng}`
      : null;
  const fields: Array<[string, string]> = [
    ["Confirmation code", p.submissionCode],
    ["Company", p.clientName],
    ["Driver", p.driverName],
    ["Truck", p.truckNumber],
    ["Load type", p.loadType],
    ["Quantity", p.quantity || "—"],
    ["Weight", p.weight || "—"],
    ["Loading location", p.location],
    ["Receiving site", p.receivingSite || "—"],
    ["Submitted", when],
    ["GPS", mapsUrl ? `${p.gpsLat}, ${p.gpsLng}` : "not captured"],
    ...(p.notes ? ([["Notes", p.notes]] as Array<[string, string]>) : []),
    ...(typeof p.ticketsRemaining === "number"
      ? ([["Prepaid dumps remaining", String(p.ticketsRemaining)]] as Array<[string, string]>)
      : []),
  ];
  const text =
    `Dump / Load Form — ${p.clientName}\n\n` +
    fields.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (mapsUrl ? `\nMap: ${mapsUrl}` : "") +
    `\n\nSubmitted via the Engage Hydrovac Services client portal.`;
  const rows = fields
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;font-weight:600;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; margin: 0 0 4px 0;">Dump / Load Form</h1>
  <p style="margin: 0 0 16px 0; color: #666; font-size: 13px;">${escapeHtml(p.clientName)} — submitted via the EHS client portal</p>
  <table style="border-collapse: collapse; font-size: 14px;">${rows}</table>
  ${
    mapsUrl
      ? `<p style="margin: 16px 0 0 0;"><a href="${escapeHtml(mapsUrl)}" style="color: #D7261E; font-weight: 600;">View pickup location on map</a></p>`
      : ""
  }
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #888;">Engage Hydrovac Services — automated copy, do not reply.</p>
</body>
</html>`;
  return { subject, html, text };
}

// Weekly per-client digest: every Monday each client gets the week's dumps
// (replaces Formstack's scheduled exports).
export function buildWeeklyDigestEmail(p: {
  clientName: string;
  fromIso: string;
  toIso: string;
  rows: Array<{
    code: string;
    loggedAt: string;
    driver: string;
    truck: string;
    load: string;
    qty: string;
    weight: string;
    status: string;
  }>;
  ticketsBalance: number | null;
}): { subject: string; html: string; text: string } {
  const fromD = p.fromIso.slice(0, 10);
  const toD = p.toIso.slice(0, 10);
  const subject = `Weekly dump report ${fromD} → ${toD} — ${p.clientName} (${p.rows.length} loads)`;
  const text =
    `Weekly dump report for ${p.clientName} (${fromD} to ${toD})\n\n` +
    `${p.rows.length} load${p.rows.length === 1 ? "" : "s"} submitted.\n` +
    (p.ticketsBalance != null ? `Prepaid dump tickets remaining: ${p.ticketsBalance}\n` : "") +
    `\n` +
    p.rows
      .map(
        (r) =>
          `${r.loggedAt.slice(0, 16).replace("T", " ")} | ${r.code} | ${r.driver} | truck ${r.truck} | ${r.load} ${r.qty || r.weight} | ${r.status}`,
      )
      .join("\n");
  const tr = p.rows
    .map(
      (r) =>
        `<tr>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(r.loggedAt.slice(0, 16).replace("T", " "))}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(r.code)}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;">${escapeHtml(r.driver)}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;">${escapeHtml(r.truck)}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;">${escapeHtml(`${r.load} ${r.qty || r.weight}`.trim())}</td>` +
        `<td style="padding:5px 8px;border-bottom:1px solid #eee;">${escapeHtml(r.status)}</td>` +
        `</tr>`,
    )
    .join("");
  const html = `<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; margin: 0 0 4px 0;">Weekly dump report — ${escapeHtml(p.clientName)}</h1>
  <p style="margin: 0 0 16px 0; color: #666; font-size: 13px;">${fromD} to ${toD} · ${p.rows.length} load${p.rows.length === 1 ? "" : "s"}${
    p.ticketsBalance != null
      ? ` · <strong style="color:${p.ticketsBalance <= 20 ? "#D7261E" : "#1a1a1a"};">${p.ticketsBalance} prepaid tickets remaining</strong>`
      : ""
  }</p>
  <table style="border-collapse: collapse; font-size: 13px; width: 100%;">
    <tr style="text-align:left;color:#666;"><th style="padding:5px 8px;">Date</th><th style="padding:5px 8px;">Code</th><th style="padding:5px 8px;">Driver</th><th style="padding:5px 8px;">Truck</th><th style="padding:5px 8px;">Load</th><th style="padding:5px 8px;">Status</th></tr>
    ${tr}
  </table>
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #888;">Engage Hydrovac Services — automated weekly report.</p>
</body>
</html>`;
  return { subject, html, text };
}

// Low-balance warning for prepaid dump tickets ("you're down to N dumps").
export function buildTicketLowBalanceEmail(p: {
  clientName: string;
  remaining: number;
  threshold: number;
}): { subject: string; html: string; text: string } {
  const subject = `Prepaid dump tickets low — ${p.remaining} remaining for ${p.clientName}`;
  const text =
    `Hi,\n\n${p.clientName} has ${p.remaining} prepaid dump tickets remaining ` +
    `(alert threshold: ${p.threshold}).\n\nPlease arrange to purchase more dump tickets ` +
    `to avoid interruptions at the receiving facility.\n\n— Engage Hydrovac Services`;
  const html = `<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 18px; margin: 0 0 16px 0;">Prepaid dump tickets running low</h1>
  <p style="margin: 0 0 12px 0;"><strong>${escapeHtml(p.clientName)}</strong> has
    <strong style="color: #D7261E;">${p.remaining}</strong> prepaid dump tickets remaining
    (alert threshold: ${p.threshold}).</p>
  <p style="margin: 0 0 12px 0;">Please arrange to purchase more dump tickets to avoid
    interruptions at the receiving facility.</p>
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #888;">Engage Hydrovac Services — automated alert.</p>
</body>
</html>`;
  return { subject, html, text };
}

export function buildInviteEmail(
  p: InviteEmailParams,
): { subject: string; html: string; text: string } {
  const org = escapeHtml(p.orgName ?? "Engage Hydrovac CRM");
  const recipient = escapeHtml(p.recipientName);
  const inviter = p.inviterName ? escapeHtml(p.inviterName) : null;
  // The action link carries &-separated query params — must be entity-escaped
  // in both the href attribute and the visible fallback text node.
  const link = escapeHtml(p.actionLink);
  const subject = `You're invited to ${p.orgName ?? "Engage Hydrovac CRM"}`;
  const text =
    `Hi ${p.recipientName},\n\n` +
    (inviter
      ? `${p.inviterName} has invited you to ${p.orgName ?? "Engage Hydrovac CRM"}.\n\n`
      : `You've been invited to ${p.orgName ?? "Engage Hydrovac CRM"}.\n\n`) +
    `Click the link below to set your password and sign in:\n${p.actionLink}\n\n` +
    `If you didn't expect this invite, it's safe to ignore — the link will expire soon.`;
  const html = `<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 20px; margin: 0 0 16px 0;">You're invited to ${org}</h1>
  <p style="margin: 0 0 16px 0;">Hi ${recipient},</p>
  <p style="margin: 0 0 16px 0;">${
    inviter
      ? `${inviter} has invited you to join <strong>${org}</strong>.`
      : `You've been invited to join <strong>${org}</strong>.`
  }</p>
  <p style="margin: 0 0 24px 0;">Click the button below to set your password and sign in:</p>
  <p style="margin: 0 0 24px 0;">
    <a href="${link}" style="display: inline-block; background: #F59E0B; color: #1a1a1a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Accept invite &amp; set password</a>
  </p>
  <p style="margin: 0 0 8px 0; font-size: 13px; color: #666;">If the button doesn't work, copy and paste this link:</p>
  <p style="margin: 0 0 24px 0; font-size: 13px; color: #666; word-break: break-all;">${link}</p>
  <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
  <p style="margin: 0; font-size: 12px; color: #888;">If you didn't expect this invite, it's safe to ignore — the link will expire automatically.</p>
</body>
</html>`;
  return { subject, html, text };
}
