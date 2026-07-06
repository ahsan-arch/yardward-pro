// Forwards uncaught browser errors + unhandled rejections to the centralized
// public.report_error RPC so admins can triage them in /admin/errors.
//
// Defenses against runaway error loops:
//   1. Dedup: same errorCode+message within DEDUP_WINDOW_MS is dropped.
//   2. Throttle: max MAX_REPORTS_PER_MIN posts per rolling 60s window.
//   3. Circuit breaker: after FAILURE_THRESHOLD consecutive RPC failures the
//      reporter pauses for BREAKER_COOLDOWN_MS to avoid hammering a dead RPC.

import { supabase } from "./supabase";

// ---------------------------------------------------------------------------
// Session id (stable per browser tab, used to correlate anonymous errors)
// ---------------------------------------------------------------------------
const SESSION_KEY = "yp_session_id";

function getSessionId(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `sess-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runaway protection
// ---------------------------------------------------------------------------
const DEDUP_WINDOW_MS = 5_000;
const MAX_REPORTS_PER_MIN = 30;
const FAILURE_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

const recentReports = new Map<string, number>(); // dedup key -> timestamp
const reportTimestamps: number[] = []; // rolling 60s window
let consecutiveFailures = 0;
let breakerOpenedAt = 0;

function shouldReport(dedupKey: string): boolean {
  const now = Date.now();

  // Circuit breaker
  if (breakerOpenedAt && now - breakerOpenedAt < BREAKER_COOLDOWN_MS) return false;
  if (breakerOpenedAt && now - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
    breakerOpenedAt = 0;
    consecutiveFailures = 0;
  }

  // Dedup
  const lastSeen = recentReports.get(dedupKey);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) return false;

  // Throttle
  while (reportTimestamps.length && now - reportTimestamps[0] > 60_000) {
    reportTimestamps.shift();
  }
  if (reportTimestamps.length >= MAX_REPORTS_PER_MIN) return false;

  // Accept
  recentReports.set(dedupKey, now);
  reportTimestamps.push(now);

  // Garbage-collect the dedup map so it can't grow unbounded
  if (recentReports.size > 200) {
    for (const [k, ts] of recentReports) {
      if (now - ts > DEDUP_WINDOW_MS) recentReports.delete(k);
    }
  }

  return true;
}

function recordOutcome(ok: boolean) {
  if (ok) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      breakerOpenedAt = Date.now();
      console.warn(
        "[reportErrorToServer] circuit breaker open: too many consecutive RPC failures",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// reportErrorToServer — fire-and-forget, never throws.
// ---------------------------------------------------------------------------
export type ErrorSeverity = "info" | "warn" | "error" | "critical";

export type ReportErrorInput = {
  severity?: ErrorSeverity;
  errorCode: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown>;
};

// Skip these so the prod error_log stays meaningful:
//
//  1. /debug/* routes — the ErrorBoundary test deliberately crashes them.
//  2. Headless browsers (navigator.webdriver = true) — Playwright runs.
//  3. HMR context-loss in dev — editing AuthContext.tsx triggers a
//     "useAuth must be within AuthProvider" that's a build artefact, not a bug.
//  4. Dev builds (import.meta.env.DEV) — local mock-mode sessions try to
//     INSERT mock ids like "A-01" into UUID columns; not a real-user path.
//  5. Leaflet map-teardown race — navigating away from a map page can fire a
//     "_leaflet_pos" read on an already-removed pane (in an async animation
//     frame or a react-leaflet commit). It's benign: the user is leaving and
//     the map re-initializes cleanly on the next mount. VehicleMap already
//     guards/contains it (mounted-ref + map.stop() + a map-only boundary);
//     this keeps the residual async frames out of the triage log.
function shouldSkipReport(input: ReportErrorInput): boolean {
  if (typeof window === "undefined") return false;
  const pathname = window.location?.pathname ?? "";
  if (pathname.startsWith("/debug/")) return true;
  if (typeof navigator !== "undefined" && navigator.webdriver === true) return true;
  if (/must be within \w+Provider/.test(input.message ?? "")) return true;
  if (/_leaflet_pos/.test(input.message ?? "")) return true;
  if (import.meta.env.DEV) return true;
  return false;
}

export async function reportErrorToServer(input: ReportErrorInput): Promise<void> {
  try {
    if (!supabase) return;
    if (shouldSkipReport(input)) return;

    const dedupKey = `${input.errorCode}:${(input.message ?? "").slice(0, 200)}`;
    if (!shouldReport(dedupKey)) return;

    const url = typeof location !== "undefined" ? location.pathname : null;
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : null;
    const sessionId = getSessionId();

    // `report_error` is not in generated Database types yet; cast through unknown
    // so the RPC call compiles without weakening the rest of the supabase client.
    const rpc = (supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { message: string } | null }>;
    }).rpc;
    const { error } = await rpc.call(supabase, "report_error", {
      p_source: "frontend",
      p_severity: input.severity ?? "error",
      p_error_code: input.errorCode,
      p_message: input.message,
      p_stack: input.stack ?? null,
      p_url: url,
      p_user_agent: userAgent,
      p_context: input.context ?? {},
      p_session_id: sessionId,
    });
    if (error) {
      recordOutcome(false);
      console.warn("[reportErrorToServer] rpc failed:", error.message);
    } else {
      recordOutcome(true);
    }
  } catch (err) {
    recordOutcome(false);
    console.warn("[reportErrorToServer] threw:", err);
  }
}

// ---------------------------------------------------------------------------
// Global handlers (registered once on first import)
// ---------------------------------------------------------------------------
let globalHandlersRegistered = false;

function registerGlobalHandlers() {
  if (globalHandlersRegistered) return;
  if (typeof globalThis.addEventListener !== "function") return;
  globalHandlersRegistered = true;

  globalThis.addEventListener("error", (event) => {
    const e = event as ErrorEvent;
    const err = e.error ?? event;
    const message =
      err instanceof Error ? err.message : typeof e.message === "string" ? e.message : "Unknown error";
    const stack = err instanceof Error ? err.stack ?? null : null;
    void reportErrorToServer({
      severity: "error",
      errorCode: "WINDOW_ERROR",
      message,
      stack,
      context: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      },
    });
  });

  globalThis.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Unhandled promise rejection";
    const stack = reason instanceof Error ? reason.stack ?? null : null;
    void reportErrorToServer({
      severity: "error",
      errorCode: "UNHANDLED_REJECTION",
      message,
      stack,
    });
  });
}

registerGlobalHandlers();
