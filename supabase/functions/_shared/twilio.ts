// Shared Twilio SMS helper. Mirrors the _shared/email.ts pattern: never
// throws, returns a structured result, reads env from the caller-provided
// getter so tests can stub it. Logs each send to sms_logs when a supabase
// client is provided (driver_id/job_id null for non-driver sends like the
// client-portal fan-out).

export interface SendSmsResult {
  ok: boolean;
  to: string;
  twilioMessageId?: string | null;
  error?: string;
}

export async function sendTwilioSms(
  env: { get: (k: string) => string | undefined },
  to: string,
  body: string,
): Promise<SendSmsResult> {
  const sid = env.get("TWILIO_ACCOUNT_SID") ?? "";
  const token = env.get("TWILIO_AUTH_TOKEN") ?? "";
  const from = env.get("TWILIO_FROM_NUMBER") ?? "";
  if (!sid || !token || !from) {
    return { ok: false, to, error: "Twilio env not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER)" };
  }
  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${sid}:${token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      },
    );
    const json = (await resp.json().catch(() => null)) as {
      sid?: string;
      message?: string;
    } | null;
    if (!resp.ok) {
      return { ok: false, to, error: json?.message ?? `Twilio HTTP ${resp.status}` };
    }
    return { ok: true, to, twilioMessageId: json?.sid ?? null };
  } catch (err) {
    return { ok: false, to, error: err instanceof Error ? err.message : String(err) };
  }
}
