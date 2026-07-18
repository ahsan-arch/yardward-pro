import type {
  Job,
  JobLog,
  DumpLog,
  WorkOrder,
  PurchaseRequest,
  ToolChecklistSubmission,
  TimeEntry,
  SmsLog,
  SmsDeliveryStatus,
  Client,
  DriverToken,
  InvoiceData,
  QboSyncStatus,
  TokenScope,
  ToolChecklistItem,
  VehicleInspection,
  ClientTicketSettings,
  TicketTransaction,
  TicketReplenishment,
  TicketPhoto,
  Notification,
  AppSettings,
  MaintenanceLog,
  FuelLog,
  RateLineItem,
  MaintenanceWorkOrder,
  MaintenanceWorkOrderPart,
  MaintenanceWorkOrderPriority,
  MaintenanceWorkOrderStatus,
  MaintenanceWorkOrderSource,
  Tool,
  ToolCondition,
  CoreReturn,
  BomComponent,
  WorkOrderPhoto,
} from "@/types/domain";
import { DEFAULT_APP_SETTINGS } from "@/types/domain";
import { getStore } from "@/contexts/DataContext";
import { driverById, jobById, clientById, geotabCoordsForVehicle } from "@/data/mockData";
import { supabase, USE_SUPABASE, type Row, type Update } from "./supabase";
import { reportErrorToServer } from "./error-capture";
import { fetchAppSettings as fetchAppSettingsFromDb } from "./db-queries";

/**
 * Typed error thrown by maintenance-work-order mutators.
 *
 * - `reassigned` — fired by api.updateMaintenanceWorkOrder when the patch lands
 *   on a row that exists but is no longer assigned to the calling mechanic
 *   (an admin or another mechanic took it over between sheet open and submit).
 *   Detected via the !data probe path — NOT by string-matching Postgres error
 *   messages, which produces false positives on legitimate WITH CHECK denials.
 *   The UI branches on `code === "reassigned"` to toast a friendlier message
 *   and auto-close the sheet rather than surface the raw "row not found" string.
 *
 * - `release-failed` — fired by api.releaseMaintenanceWorkOrder when the
 *   release_maintenance_work_order RPC returns ok=false (terminal status,
 *   not owned by the caller, row not found). Carries the RPC's structured
 *   error message verbatim so the toast says what actually went wrong.
 */
export class MaintenanceWorkOrderError extends Error {
  readonly code: "reassigned" | "release-failed";
  constructor(code: "reassigned" | "release-failed", message: string) {
    super(message);
    this.name = "MaintenanceWorkOrderError";
    this.code = code;
  }
}

// One imported Formstack submission (hauling record). `data` is the
// standardized field array straight from the Formstack v2025 API.
export interface FormstackSubmissionRow {
  id: string;
  submissionId: number;
  formId: number;
  formName: string;
  submittedAt: string | null;
  summary: string;
  data: Array<{
    field?: string;
    label?: string | null;
    type?: string | null;
    displayValue?: string | null;
    parsedValue?: unknown;
  }>;
  importedAt: string;
}

// ---- Form template engine (Phase 4 — self-serve forms) --------------------
// A template is a list of field definitions rendered by one generic driver
// page. John edits these in /admin/form-templates — no code changes needed
// for new JSAs / site-visit variants / one-off forms.
export interface FormTemplateField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "checkbox" | "photos";
  required: boolean;
  options?: string[];
}

export interface FormTemplate {
  id: string;
  name: string;
  kind: "jsa" | "site-visit" | "custom";
  clientId: string | null;
  fields: FormTemplateField[];
  active: boolean;
  sort: number;
}

export interface CustomFormSubmission {
  id: string;
  templateId: string | null;
  templateName: string;
  templateKind: string;
  clientId: string | null;
  submittedBy: string | null;
  submittedName: string;
  data: Record<string, unknown>;
  photos: string[];
  gpsLat: number | null;
  gpsLng: number | null;
  loggedAt: string;
}

// Extract the actual error body from a supabase functions.invoke() error.
//
// supabase-js wraps every non-2xx response from an Edge Function in a
// FunctionsHttpError whose .message is the useless string "Edge Function
// returned a non-2xx status code". The real structured error JSON lives
// on .context (a Response object). This helper clones that response,
// parses the JSON body (if any), and formats a human-readable reason
// pulling from the conventional fields our edge functions emit:
//   { error, step?, hint?, intuitError?, intuitStatus? }
//
// Returns null if the error isn't a FunctionsHttpError-shape or the body
// can't be read — caller falls back to err.message.
async function extractFunctionErrorBody(err: unknown): Promise<string | null> {
  if (!err || typeof err !== "object") return null;
  const ctx = (err as { context?: unknown }).context;
  if (!ctx || typeof ctx !== "object") return null;
  if (typeof (ctx as Response).clone !== "function") return null;
  let clone: Response;
  try {
    clone = (ctx as Response).clone();
  } catch {
    return null;
  }
  try {
    const json = (await clone.json()) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return null;
    const error = typeof json.error === "string" ? json.error : "";
    const hint = typeof json.hint === "string" ? json.hint : "";
    const intuitError = typeof json.intuitError === "string" ? json.intuitError : "";
    const step = typeof json.step === "string" ? json.step : "";
    const intuitStatus =
      typeof json.intuitStatus === "number" ? `Intuit HTTP ${json.intuitStatus}` : "";
    const parts = [error, step ? `(step: ${step})` : "", intuitStatus, intuitError, hint].filter(
      Boolean,
    );
    return parts.length > 0 ? parts.join(" — ") : null;
  } catch {
    try {
      const text = await (ctx as Response).clone().text();
      return text.slice(0, 500) || null;
    } catch {
      return null;
    }
  }
}

// Mock-mode notification fan-out to every admin. store.admins is only ever
// hydrated from a real Supabase fetch (empty in pure mock mode — see
// DataContext's `useState<Admin[]>([])`), so this falls back to the single
// demo admin persona ("A-01" / Alex Chen) when the roster is empty, matching
// the userId convention every seed notification in mockData.ts already uses.
// Only for the mock-mode branch of a write path — the Supabase branch's
// equivalent behavior comes from a DB trigger instead (SECURITY DEFINER, so
// it can insert into notifications despite the caller having no direct
// write access — see the PPE and low-stock trigger migrations).
function notifyAllAdminsMock(
  store: ReturnType<typeof getStore>,
  type: Notification["type"],
  body: string,
  link: string,
): void {
  const targets = store.admins.length > 0 ? store.admins.map((a) => a.id) : ["A-01"];
  for (const adminId of targets) {
    store.pushNotification({
      id: uid("NOTIF"),
      userId: adminId,
      type,
      body,
      link,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  }
}

// Mock-mode mirror of trg_jobs_notify_equipment_prep (see
// 20260718100000_job_additional_equipment.sql) — same "notify every mechanic"
// fan-out as notifyAllAdminsMock above, targeting the workshop instead.
function notifyAllMechanicsMock(
  store: ReturnType<typeof getStore>,
  type: Notification["type"],
  body: string,
  link: string,
): void {
  const targets = store.mechanics.length > 0 ? store.mechanics.map((m) => m.id) : ["M-01"];
  for (const mechanicId of targets) {
    store.pushNotification({
      id: uid("NOTIF"),
      userId: mechanicId,
      type,
      body,
      link,
      readAt: null,
      createdAt: new Date().toISOString(),
    });
  }
}

// Mock-mode mirror of trg_inventory_items_notify_low_stock (see
// 20260717130000_low_stock_alerts.sql) — "was it low before, is it low now"
// on the same crossed-threshold semantics, shared by every mock-mode write
// path that can move qty_on_hand or reorder_point (admin/mechanic edits,
// and a mechanic completing a work order with parts used).
function maybeNotifyLowStockMock(
  store: ReturnType<typeof getStore>,
  before: { name: string; sku: string; qtyOnHand: number; reorderPoint: number },
  newQty: number,
  newReorder: number,
): void {
  const wasLow = before.qtyOnHand <= before.reorderPoint;
  const isLow = newQty <= newReorder;
  if (!wasLow && isLow) {
    notifyAllAdminsMock(
      store,
      "alert",
      `Low stock: ${before.name} (${before.sku}) — ${newQty} on hand, reorder point ${newReorder}.`,
      "/admin/inventory",
    );
  }
}

// Small helper: log the supabase error to the server and return the message we
// will throw to callers. Keeps each call site to two lines instead of five.
function reportApiError(
  errorCode: string,
  err:
    | { message: string; details?: string | null; hint?: string | null; code?: string | null }
    | null
    | undefined,
  context: Record<string, unknown> = {},
): string {
  const message = err?.message ?? "Unknown supabase error";
  void reportErrorToServer({
    severity: "error",
    errorCode,
    message: `${errorCode.toLowerCase()}: ${message}`,
    context: {
      ...context,
      pgDetails: err?.details ?? null,
      pgHint: err?.hint ?? null,
      pgCode: err?.code ?? null,
    },
  });
  return message;
}

type SmsLogRow = {
  id: string;
  driver_id: string | null;
  job_id: string | null;
  body: string;
  sent_at: string | null;
  twilio_message_id: string | null;
  delivery_status: SmsDeliveryStatus;
};
import {
  domainClientToDb,
  domainJobToDb,
  domainWorkOrderToDb,
  domainMaintenanceLogToDb,
  domainFuelLogToDb,
  domainToolToDb,
  dbMaintenanceWorkOrderToDomain,
  domainCoreReturnToDb,
  dbWorkOrderPhotoToDomain,
} from "./db-mappers";

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

// -----------------------------------------------------------------------------
// Idempotency-aware insert helper.
//
// The offline queue mints a stable `idempotencyKey` once at enqueue time and
// replays the same payload on each retry. The matching server tables carry a
// PARTIAL UNIQUE INDEX on `idempotency_key WHERE idempotency_key IS NOT NULL`
// (see 20260602121520_preprod_fixmore_auth_atomicity.sql §5), so the SECOND
// insert of an item whose first response was lost to a flaky network hits a
// Postgres 23505 unique_violation instead of silently double-inserting. This
// helper catches that specific error, looks the original row back up by key,
// and returns it as if the first insert had succeeded — which from the
// driver's point of view it had: the only thing we lost was the HTTP ack.
//
// Why we don't blanket-catch every unique violation: a 23505 on a DIFFERENT
// constraint (e.g. a real domain pk collision) is a real bug and must throw.
// We gate the swallow on `row.idempotency_key` being set AND the SELECT-back
// actually finding a row that matches the key, which only the partial unique
// index can produce.
//
// Returns the inserted (or matched-existing) row. Callers that don't need the
// row back ignore the return value — they already have the domain object they
// built client-side.
// -----------------------------------------------------------------------------
async function insertWithIdempotency<T extends { idempotency_key?: string | null }>(
  table:
    | "work_orders"
    | "vehicle_inspections"
    | "tool_checklist_submissions"
    | "job_logs"
    | "dump_logs"
    | "purchase_requests"
    | "ticket_photos"
    | "maintenance_work_orders",
  row: T,
): Promise<T> {
  if (!supabase) throw new Error(`insertWithIdempotency: supabase client unavailable`);
  // Untyped client: dump_logs postdates the generated Database types
  // snapshot, and this helper only ever round-trips rows the caller built —
  // the generic T pins the shape. Re-run `supabase gen types` to retire this.
  const client = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
  // `.insert(row).select().single()` round-trips the inserted row so we have
  // the persisted values (including server-side defaults like `created_at`)
  // to hand back to the caller. We need the .single() shape either way to
  // get a structured 23505 PostgrestError on a partial-unique-index collision
  // instead of a silently-empty `data` array.
  const { data, error } = await client
    .from(table)
    .insert(row as never)
    .select()
    .single();
  if (!error) return data as unknown as T;
  // 23505 = unique_violation. We only swallow it for the idempotency_key
  // path — any other unique-constraint hit (e.g. pk collision on `id`) is
  // a real bug and must propagate.
  if (error.code === "23505" && row.idempotency_key) {
    const { data: existing, error: selErr } = await client
      .from(table)
      .select()
      .eq("idempotency_key", row.idempotency_key)
      .single();
    if (!selErr && existing) return existing as unknown as T;
    // SELECT-back failed — fall through and throw the original 23505 so the
    // caller (or the offline-queue retry path) treats the submission as
    // still-not-confirmed rather than silently succeeding on a row we
    // couldn't actually verify exists.
  }
  throw error;
}

// Round-trip the inventory snapshot through JSON.parse/stringify so the strict
// InventoryCheckSnapshot interface (which doesn't have a string index
// signature) cleanly satisfies Supabase's generated Json type. We're already
// going to wire bytes here on the way out, so paying the (one-time, tiny)
// serialise cost is cheaper than scattering `as unknown as Json` casts.
function serializeInventoryCheckResult(
  snap: import("@/types/domain").InventoryCheckSnapshot[] | null,
): import("./database.types").Json {
  if (snap == null) return null;
  return JSON.parse(JSON.stringify(snap)) as import("./database.types").Json;
}

/**
 * Resolve the real actor uuid for a driver/mechanic mutation.
 * 1. Driver-token (/t/<token>) sessions never call supabase.auth — the
 *    t.$token bridge only writes sessionStorage. The real driver uuid lives
 *    under "fo:driver-token-driver-id". AuthContext keeps user.id at the mock
 *    seed ("A-01") for these sessions, so trusting the route-supplied id would
 *    write "A-01" into a uuid column.
 * 2. Otherwise fall back to the signed-in Supabase user (same fix as createJob).
 * Returns null when neither is available; callers writing NOT NULL uuid columns
 * must throw a clear error rather than send a mock/empty id.
 */
async function currentActorId(): Promise<string | null> {
  if (typeof window !== "undefined") {
    try {
      const tokenDriverId = window.sessionStorage.getItem("fo:driver-token-driver-id");
      if (tokenDriverId) return tokenDriverId;
    } catch {
      /* sessionStorage blocked (private-mode webview) — fall through */
    }
  }
  if (USE_SUPABASE && supabase) {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  }
  return null;
}

export const api = {
  // Auth
  login: async (_email: string, _password: string) => {
    await wait(200);
    return { ok: true };
  },
  logout: async () => {
    await wait(50);
    return { ok: true };
  },

  // Jobs
  createClient: async (input: Omit<Client, "id">) => {
    const client: Client = { ...input, id: uid("C") };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("clients").insert(domainClientToDb(client));
      if (error) {
        throw new Error(
          `createClient: ${reportApiError("CREATE_CLIENT", error, { clientId: client.id })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().createClient(client);
    return client;
  },
  createJob: async (input: Omit<Job, "id" | "createdAt">) => {
    const job: Job = { ...input, id: uid("JOB"), createdAt: new Date().toISOString() };
    if (USE_SUPABASE && supabase) {
      // The admin UI passes a mock createdBy ("A-01"); the real creator is the
      // signed-in user. jobs.created_by is a uuid FK, so a mock id throws
      // "invalid input syntax for type uuid". Override with the authenticated
      // user's uuid (created_by is nullable, so "" -> null is a safe fallback
      // via domainJobToDb's `j.createdBy || null`).
      const { data: authData } = await supabase.auth.getUser();
      job.createdBy = authData.user?.id ?? "";
      const { error } = await supabase.from("jobs").insert(domainJobToDb(job));
      if (error)
        throw new Error(`createJob: ${reportApiError("CREATE_JOB", error, { jobId: job.id })}`);
      // trg_jobs_notify_equipment_prep handles the mechanic fan-out server-side.
    } else {
      await wait();
      if (job.additionalEquipment.length > 0) {
        notifyAllMechanicsMock(
          getStore(),
          "job",
          `Prepare additional equipment for ${job.id} before dispatch: ${job.additionalEquipment.join(", ")}`,
          "/mechanic",
        );
      }
    }
    getStore().createJob(job);
    return job;
  },
  updateJob: async (id: string, patch: Partial<Job>) => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("jobs")
        .update({
          ...(patch.driverId !== undefined && { driver_id: patch.driverId }),
          ...(patch.vehicleId !== undefined && { vehicle_id: patch.vehicleId }),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.notes !== undefined && { notes: patch.notes }),
          ...(patch.scheduledAt !== undefined && { scheduled_at: patch.scheduledAt }),
          ...(patch.durationMin !== undefined && { duration_min: patch.durationMin }),
        })
        .eq("id", id);
      if (error)
        throw new Error(`updateJob: ${reportApiError("UPDATE_JOB", error, { jobId: id })}`);
    } else {
      await wait();
    }
    getStore().updateJob(id, patch);
    return { ok: true };
  },
  assignJob: async (jobId: string, driverId: string, vehicleId: string) => {
    await wait();
    const s = getStore();
    s.updateJob(jobId, { driverId, vehicleId });
    const j = s.jobs.find((x) => x.id === jobId) ?? jobById(jobId);
    // Drafts are private — never trigger SMS or downstream notifications until
    // an admin explicitly publishes the job.
    if (j?.status === "draft") {
      return { ok: true, skippedSms: true as const };
    }
    const driver = driverById(driverId);
    const body = `${jobId} assigned · ${j?.location.address ?? ""} · ${j?.scheduledAt.slice(11, 16) ?? ""}`;
    // SMS is best-effort — a notification failure (no phone, Twilio hiccup)
    // must never fail the assignment itself.
    try {
      await api.sendSms(driver?.id ?? driverId, body, jobId);
    } catch (err) {
      void reportErrorToServer({
        severity: "warn",
        errorCode: "ASSIGN_JOB_SMS",
        message: `assign_job_sms: ${err instanceof Error ? err.message : String(err)}`,
        context: { jobId, driverId },
      });
      return { ok: true, smsFailed: true as const };
    }
    return { ok: true };
  },
  // Flips a draft → scheduled and fires the normal assignment SMS that the
  // job would have triggered at create time if it weren't a draft.
  publishJob: async (jobId: string) => {
    const s = getStore();
    const existing = s.jobs.find((x) => x.id === jobId) ?? jobById(jobId);
    if (!existing) throw new Error(`publishJob: job ${jobId} not found`);
    if (existing.status !== "draft") {
      // Idempotent: publishing an already-published job is a no-op rather
      // than a spurious double-SMS.
      return { ok: true, alreadyPublished: true as const };
    }
    await api.updateJob(jobId, { status: "scheduled" });
    if (existing.driverId) {
      const driver = driverById(existing.driverId);
      const body = `${jobId} assigned · ${existing.location.address ?? ""} · ${existing.scheduledAt.slice(11, 16) ?? ""}`;
      // Best-effort SMS: the job IS published regardless. sendSms returns null
      // when the driver has no valid phone (intentionally skipped), and any
      // thrown error is downgraded to a soft warning so publish never fails.
      try {
        const sms = await api.sendSms(driver?.id ?? existing.driverId, body, jobId);
        return sms ? { ok: true, sms } : { ok: true, smsSkipped: true as const };
      } catch (err) {
        void reportErrorToServer({
          severity: "warn",
          errorCode: "PUBLISH_JOB_SMS",
          message: `publish_job_sms: ${err instanceof Error ? err.message : String(err)}`,
          context: { jobId, driverId: existing.driverId },
        });
        return { ok: true, smsFailed: true as const };
      }
    }
    return { ok: true };
  },

  // Job logs (mid-shift driver notes)
  // The id is generated client-side with the same JL- prefix the DB uses for
  // RLS lookups. When offline we stash the payload in the local queue so the
  // driver gets an instant success state; the queue flushes on `online`.
  submitJobLog: async (input: Omit<JobLog, "id" | "createdAt"> & { idempotencyKey?: string }) => {
    const log: JobLog = {
      ...input,
      id: uid("JL"),
      createdAt: new Date().toISOString(),
    };
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!online) {
      // Lazy import — offline-queue imports api, so a top-level import would
      // create a circular dependency.
      const { offlineQueue } = await import("./offline-queue");
      await offlineQueue.enqueue({ kind: "jobLog", payload: input });
      return log;
    }
    if (USE_SUPABASE && supabase) {
      try {
        await insertWithIdempotency("job_logs", {
          id: log.id,
          job_id: log.jobId,
          driver_id: log.driverId,
          vehicle_id: log.vehicleId,
          body: log.body,
          gps_lat: log.gpsLat,
          gps_lng: log.gpsLng,
          logged_at: log.loggedAt,
          idempotency_key: input.idempotencyKey,
        });
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitJobLog: ${reportApiError("SUBMIT_JOB_LOG", e, { jobLogId: log.id, jobId: log.jobId })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().submitJobLog(log);
    return log;
  },

  // Dump logs (native hauling records — replaces Formstack for new entries)
  // Mirrors submitJobLog: client-side id, offline-queue fallback, idempotent
  // insert keyed on idempotencyKey so a flush replay never double-inserts.
  submitDumpLog: async (
    input: Omit<
      DumpLog,
      | "id"
      | "createdAt"
      | "clientId"
      | "submissionCode"
      | "source"
      | "submittedName"
      | "truckNumber"
      | "status"
      | "approvedBy"
      | "approvedAt"
    > & { idempotencyKey?: string },
  ) => {
    // Portal-only fields default here: driver-app records carry the auth
    // driver instead of a typed-in name, and the DB defaults mirror these.
    const log: DumpLog = {
      ...input,
      clientId: null,
      submissionCode: null,
      source: "driver-app",
      submittedName: "",
      truckNumber: "",
      status: "submitted",
      approvedBy: null,
      approvedAt: null,
      id: uid("DL"),
      createdAt: new Date().toISOString(),
    };
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!online) {
      const { offlineQueue } = await import("./offline-queue");
      await offlineQueue.enqueue({ kind: "dumpLog", payload: input });
      return log;
    }
    if (USE_SUPABASE && supabase) {
      try {
        await insertWithIdempotency("dump_logs", {
          id: log.id,
          driver_id: log.driverId,
          job_id: log.jobId,
          vehicle_id: log.vehicleId,
          load_type: log.loadType,
          quantity: log.quantity,
          weight: log.weight,
          location: log.location,
          receiving_site: log.receivingSite,
          notes: log.notes,
          gps_lat: log.gpsLat,
          gps_lng: log.gpsLng,
          logged_at: log.loggedAt,
          idempotency_key: input.idempotencyKey,
        });
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitDumpLog: ${reportApiError("SUBMIT_DUMP_LOG", e, { dumpLogId: log.id, jobId: log.jobId })}`,
        );
      }
    } else {
      await wait();
    }
    return log;
  },

  // Admin read for /admin/hauling-records "App" tab. RLS scopes drivers to
  // their own rows, admins to everything.
  fetchDumpLogs: async (input: {
    limit?: number;
    offset?: number;
  }): Promise<{ rows: DumpLog[]; total: number }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { rows: [], total: 0 };
    }
    const limit = Math.min(input.limit ?? 50, 200);
    const offset = input.offset ?? 0;
    // dump_logs postdates the generated Database types snapshot — untyped
    // client until `supabase gen types` is re-run (same caveat as the
    // formstack_submissions reads).
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error, count } = await untyped
      .from("dump_logs")
      .select(
        "id,driver_id,job_id,vehicle_id,client_id,submission_code,source,submitted_name,truck_number,status,approved_by,approved_at,load_type,quantity,weight,location,receiving_site,notes,gps_lat,gps_lng,logged_at,created_at",
        { count: "exact" },
      )
      .order("logged_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      throw new Error(`fetchDumpLogs: ${reportApiError("FETCH_DUMP_LOGS", error, input)}`);
    }
    return {
      rows: (data ?? []).map((r) => ({
        id: r.id as string,
        driverId: (r.driver_id as string | null) ?? null,
        jobId: (r.job_id as string | null) ?? null,
        vehicleId: (r.vehicle_id as string | null) ?? null,
        clientId: (r.client_id as string | null) ?? null,
        submissionCode: (r.submission_code as string | null) ?? null,
        source: ((r.source as string) === "client-portal" ? "client-portal" : "driver-app") as
          | "driver-app"
          | "client-portal",
        submittedName: (r.submitted_name as string) ?? "",
        truckNumber: (r.truck_number as string) ?? "",
        status: (r.status as string) ?? "submitted",
        approvedBy: (r.approved_by as string | null) ?? null,
        approvedAt: (r.approved_at as string | null) ?? null,
        loadType: (r.load_type as string) ?? "",
        quantity: (r.quantity as string) ?? "",
        weight: (r.weight as string) ?? "",
        location: (r.location as string) ?? "",
        receivingSite: (r.receiving_site as string) ?? "",
        notes: (r.notes as string) ?? "",
        gpsLat: (r.gps_lat as number | null) ?? null,
        gpsLng: (r.gps_lng as number | null) ?? null,
        loggedAt: (r.logged_at as string) ?? "",
        createdAt: (r.created_at as string) ?? "",
      })),
      total: count ?? 0,
    };
  },

  // Yard sign-off (Phase 2 regulatory approval): the yard guy approves the
  // disposal when the truck arrives. Status-guarded so a double-click or a
  // second admin can't overwrite the original signer.
  approveDumpLog: async (input: {
    id: string;
    approverName: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("dump_logs")
      .update({
        status: "approved",
        approved_by: input.approverName,
        approved_at: new Date().toISOString(),
      })
      .eq("id", input.id)
      .eq("status", "submitted")
      .select("id");
    if (error) {
      return { ok: false, reason: reportApiError("APPROVE_DUMP_LOG", error, { id: input.id }) };
    }
    if (!data || data.length === 0) {
      return { ok: false, reason: "Already approved by someone else (refresh to see who)" };
    }
    return { ok: true };
  },

  // Internal (staff) notification recipients for portal submissions — stored
  // on the app_settings singleton; per-client recipients live on clients.
  fetchPortalNotifySettings: async (): Promise<{ sms: string[]; emails: string[] }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { sms: [], emails: [] };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("app_settings")
      .select("portal_notify_sms, portal_notify_emails")
      .eq("id", "default")
      .maybeSingle();
    if (error) {
      throw new Error(`fetchPortalNotifySettings: ${reportApiError("FETCH_PORTAL_NOTIFY", error)}`);
    }
    return {
      sms: (data?.portal_notify_sms as string[]) ?? [],
      emails: (data?.portal_notify_emails as string[]) ?? [],
    };
  },

  updatePortalNotifySettings: async (input: {
    sms: string[];
    emails: string[];
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped
      .from("app_settings")
      .update({
        portal_notify_sms: input.sms.map((s) => s.trim()).filter(Boolean),
        portal_notify_emails: input.emails.map((s) => s.trim()).filter(Boolean),
      })
      .eq("id", "default");
    if (error) {
      return { ok: false, reason: reportApiError("UPDATE_PORTAL_NOTIFY", error) };
    }
    return { ok: true };
  },

  // Work orders
  submitWorkOrder: async (
    input: Omit<WorkOrder, "id" | "submittedAt" | "status"> & { idempotencyKey?: string },
  ) => {
    const wo: WorkOrder = {
      ...input,
      id: uid("WO"),
      submittedAt: new Date().toISOString(),
      status: "pending",
    };
    if (USE_SUPABASE && supabase) {
      try {
        // Mapper produces the snake_case row shape; the offline-queue's
        // idempotencyKey rides alongside as the dedupe handle (it's not in
        // the domain object, only on the input).
        await insertWithIdempotency("work_orders", {
          ...domainWorkOrderToDb(wo),
          idempotency_key: input.idempotencyKey,
        });
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitWorkOrder: ${reportApiError("SUBMIT_WORK_ORDER", e, { workOrderId: wo.id })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().submitWorkOrder(wo);
    return wo;
  },
  approveWorkOrder: async (id: string, approverId: string) => {
    const s = getStore();
    const wo = s.workOrders.find((w) => w.id === id);
    const j = wo ? jobById(wo.jobId) : undefined;
    // Prefer the live client row (post-hydration) over the static mock so a
    // rate_table_id assigned at runtime via api.upsertRateTable is honored.
    const c = j
      ? (s.clients.find((x) => x.id === j.clientId) ?? clientById(j.clientId))
      : undefined;
    // Resolve the per-tonne rate from the client's rate table. Falls back to
    // the legacy 24/tonne flat rate (with a console.warn) so a missing or
    // unmatched table never blocks approval — but it does surface the gap so
    // billing can patch the rate sheet.
    const matched = wo
      ? resolveLineItemRate(wo.loadType, "tonne", c?.rateTableId ?? null, s.rateTables)
      : null;
    const lineRate = matched?.rate ?? 24;
    // The fallback rate (24) is per-tonne; a matched rate carries its own unit.
    // CRITICAL: only multiply by tonnage when the matched rate is actually
    // per-tonne. A flat or per-load rate (e.g. "$500 flat per dump") matched
    // for a weight-based WO must bill ONCE, not $500 × the tonnage — otherwise
    // a 20-tonne load invoices at $10,000 instead of $500.
    const lineUnit = matched?.unit ?? "tonne";
    if (wo && matched == null) {
      console.warn(
        `approveWorkOrder: no rate match for client=${c?.id ?? "?"} rateTable=${c?.rateTableId ?? "(none)"} loadType="${wo.loadType}" preferredUnit=tonne — falling back to 24/tonne`,
      );
    } else if (wo && matched && matched.unit !== "tonne") {
      // Visible in observability so billing knows a load/flat rate was used
      // for a weight-based WO. Useful for invoice review.
      console.info(
        `approveWorkOrder: client=${c?.id ?? "?"} rateTable=${c?.rateTableId ?? "(none)"} matched on unit=${matched.unit} (preferred tonne) for loadType="${wo.loadType}"`,
      );
    }
    // Per-tonne rates scale by weight; load/flat/hour rates bill a single
    // unit (we have no hours on a WO, so an hour-rate match degrades to one
    // unit rather than silently multiplying by tonnage).
    const lineQty = wo ? (lineUnit === "tonne" ? wo.weightTonnes : 1) : 0;
    const lineDesc = wo
      ? lineUnit === "tonne"
        ? `${wo.loadType} haul`
        : `${wo.loadType} haul (${lineUnit} rate)`
      : "";
    const invoice: InvoiceData = {
      id: uid("INV"),
      workOrderId: id,
      clientId: c?.id ?? "",
      kind: "work-order",
      lineItems: wo
        ? [
            {
              description: lineDesc,
              qty: lineQty,
              rate: lineRate,
              amount: lineQty * lineRate,
            },
          ]
        : [],
      total: wo ? lineQty * lineRate : 0,
      qboSyncStatus: "pending",
      qboInvoiceId: null,
    };
    if (USE_SUPABASE && supabase) {
      // Atomic 3-step approval (invoice + line items + work_orders status flip)
      // delegated to the SECURITY DEFINER approve_work_order RPC so a mid-flight
      // failure can never leave the WO half-approved. The RPC row-locks the
      // work_order, validates current status, and emits a structured
      // { ok, invoice_id, wo_status, error } result.
      const { data, error } = await supabase.rpc("approve_work_order", {
        p_wo_id: id,
        p_approver_id: approverId,
        p_invoice_id: invoice.id,
        p_client_id: invoice.clientId,
        p_total: invoice.total,
        p_line_items: invoice.lineItems.map((li, idx) => ({
          description: li.description,
          qty: li.qty,
          rate: li.rate,
          amount: li.amount,
          position: idx,
        })),
      });
      if (error)
        throw new Error(
          `approveWorkOrder.rpc: ${reportApiError("APPROVE_WORK_ORDER_RPC", error, { workOrderId: id, invoiceId: invoice.id })}`,
        );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.ok) {
        const rpcStatus: string | null = row?.wo_status ?? null;
        const rpcInvoiceId: string | null = row?.invoice_id ?? null;
        const rpcError: string = row?.error ?? "approve_work_order returned ok=false";
        if (rpcStatus && rpcStatus !== "pending") {
          // Idempotent retry / concurrent click: surface the existing invoice
          // id so the caller can navigate to it instead of minting a new row.
          throw new Error(
            `approveWorkOrder: work order already ${rpcStatus} (invoice ${rpcInvoiceId ?? "?"})`,
          );
        }
        throw new Error(
          `approveWorkOrder.rpc: ${reportApiError("APPROVE_WORK_ORDER_RPC", { message: rpcError }, { workOrderId: id, invoiceId: invoice.id })}`,
        );
      }
    } else {
      await wait();
    }
    s.approveWorkOrder(id, approverId, invoice);
    if (wo && c?.id && wo.dumpSite) {
      // Fire-and-forget so approval UX isn't blocked by ticket bookkeeping.
      debitTicketForWorkOrder(id, c.id, j?.vehicleId ?? null, wo.dumpSite, approverId).catch(
        (err) => console.warn("ticket debit failed:", err.message),
      );
    }
    return invoice;
  },
  rejectWorkOrder: async (id: string, reason: string) => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("work_orders")
        .update({
          status: "rejected",
          site_issues_note: reason || "",
          approved_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error)
        throw new Error(
          `rejectWorkOrder: ${reportApiError("REJECT_WORK_ORDER", error, { workOrderId: id })}`,
        );
    } else {
      await wait();
    }
    getStore().rejectWorkOrder(id, reason);
    return { ok: true };
  },

  // ---- Rate tables ------------------------------------------------------
  // Persist the admin's edit of a client's rate sheet. ID convention is
  // `RT-${clientId}` so we get an idempotent upsert without juggling a
  // separate rate-table id in the editor UI. Strategy:
  //   1. Upsert the rate_tables row (no-op when it already exists)
  //   2. DELETE then INSERT rate_line_items — simpler than reconciling
  //      adds/removes/reorders for what is always a small list (~10 rows)
  //   3. Patch clients.rate_table_id so approveWorkOrder picks up the new
  //      pricing on the very next approval
  // Local store mirrors the same three steps in upsertClientRateTable.
  upsertRateTable: async (clientId: string, lineItems: RateLineItem[]) => {
    const rateTableId = `RT-${clientId}`;
    if (USE_SUPABASE && supabase) {
      // Atomic via the SECURITY DEFINER RPC: the DELETE + INSERT pair runs
      // in one transaction so a network blip or constraint violation rolls
      // back the wipe instead of leaving the table empty and the next
      // approveWorkOrder silently falling back to 24/tonne.
      const { error } = await supabase.rpc("upsert_client_rate_table", {
        p_client_id: clientId,
        p_line_items: lineItems.map((li, idx) => ({
          description: li.description,
          unit: li.unit,
          rate: li.rate,
          surcharges: li.surcharges,
          position: idx,
        })),
      });
      if (error)
        throw new Error(
          `upsertRateTable: ${reportApiError("UPSERT_RATE_TABLE", error, { clientId, rateTableId })}`,
        );
    } else {
      await wait();
    }
    getStore().upsertClientRateTable(clientId, rateTableId, lineItems);
    return { ok: true as const, rateTableId };
  },

  // Driver forms
  submitStartOfDay: async (p: {
    driverId: string;
    odometer: number;
    fuelLevel: string;
    condition: string;
    /**
     * Description of the condition issue ("minor"/"major"). Required by the
     * form when condition !== "ok" — see the maintenance-work-order creation
     * below, which needs real text to hand the mechanic queue.
     */
    conditionNote?: string;
    gps: { lat: number; lng: number } | null;
    /**
     * Optional client-minted key, persisted by the offline-queue and replayed
     * on retry. time_entries does not carry an idempotency_key column on this
     * schema — the dedupe guarantee is the "one open shift per driver"
     * invariant + the natural primary key (uid-randomized client-side). The
     * key is forwarded for cross-table audit symmetry with the six tables
     * that do (work_orders / inspections / etc).
     */
    idempotencyKey?: string;
    /**
     * "Any personal PPE missing?" toggle + the required reason, captured on
     * the start-of-day form. When true, a DB trigger
     * (trg_time_entries_notify_ppe_missing) fans this out to every admin's
     * notification inbox — see 20260717090000_ppe_missing_report.sql.
     */
    ppeMissing?: boolean;
    ppeMissingReason?: string;
    /**
     * "Passengers in vehicle?" toggle expanded to an actual name manifest —
     * see 20260717093000_start_of_day_passengers.sql.
     */
    passengerNames?: string[];
  }) => {
    const store = getStore();
    // Resolve the REAL driver uuid. A /t/<token> session leaves useAuth().user
    // (and thus p.driverId) at the mock "A-01"; the real uuid lives in
    // sessionStorage. In mock mode currentActorId() returns null and we keep
    // the caller-supplied id. The USE_SUPABASE branch below hard-requires a
    // real actor so "A-01" never reaches the uuid driver_id column.
    const resolvedActor = await currentActorId();
    const driverId = resolvedActor ?? p.driverId;
    // Tie the shift back to the passing pre-trip that authorised it. The
    // lockout screen in driver.start-of-day.tsx blocks submission until a
    // fresh circle-check exists for the driver's assigned vehicle, so this
    // lookup is just recording the audit trail (and stays null only for
    // drivers without a vehicle assignment).
    const driver = store.drivers.find((d) => d.id === driverId);
    const vehicleId = driver?.vehicleAssignmentId ?? null;
    const pretripInspectionId = vehicleId
      ? mostRecentPassingInspectionId(store.vehicleInspections, driverId, vehicleId)
      : null;
    const entry: TimeEntry = {
      id: uid("TE"),
      driverId,
      clockIn: new Date().toISOString(),
      clockOut: null,
      gpsClockIn: p.gps,
      gpsClockOut: null,
      vehicleMovementCorrelation: "pending",
      flagged: p.condition !== "ok",
      flagReason: p.condition !== "ok" ? `Condition: ${p.condition}` : "",
      pretripInspectionId,
      ppeMissing: p.ppeMissing ?? false,
      ppeMissingReason: p.ppeMissing ? (p.ppeMissingReason ?? "") : "",
      passengerNames: p.passengerNames ?? [],
    };
    if (USE_SUPABASE && supabase) {
      if (!resolvedActor) throw new Error("submitStartOfDay: no authenticated actor");
      // Persist the open shift row so payroll/QBO sees real hours. Previously
      // this only mutated useFleetStore and the entry vanished on reload —
      // the time-entries-never-persisted bug. Bubble any DB error so the
      // offline-queue can retry / dead-letter.
      const { error } = await supabase.from("time_entries").insert({
        id: entry.id,
        driver_id: entry.driverId,
        clock_in: entry.clockIn,
        clock_out: null,
        gps_clock_in_lat: entry.gpsClockIn?.lat ?? null,
        gps_clock_in_lng: entry.gpsClockIn?.lng ?? null,
        gps_clock_out_lat: null,
        gps_clock_out_lng: null,
        vehicle_movement_correlation: entry.vehicleMovementCorrelation,
        ppe_missing: entry.ppeMissing,
        ppe_missing_reason: entry.ppeMissingReason,
        passenger_names: entry.passengerNames,
        flagged: entry.flagged,
        flag_reason: entry.flagReason,
        pretrip_inspection_id: entry.pretripInspectionId ?? null,
      });
      if (error)
        throw new Error(
          `submitStartOfDay: ${reportApiError("SUBMIT_START_OF_DAY", error, { driverId: p.driverId, entryId: entry.id, idempotencyKey: p.idempotencyKey ?? null })}`,
        );
      // The morning odometer entry doubles as the vehicle's odometer feed —
      // this is what preventive-maintenance-check reads, so manual entry
      // replaces the Geotab odometer when hardware tracking is dropped.
      // Best-effort (monotonic guard lives in the RPC); never fails the shift.
      if (p.odometer > 0) {
        // RPC postdates the generated types snapshot — untyped client cast.
        const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
        void untyped
          .rpc("record_vehicle_odometer", { p_odometer: Math.round(p.odometer) })
          .then(() => {});
      }
    } else {
      await wait();
      // Mock mode has no DB trigger to fan this out, so mirror
      // trg_time_entries_notify_ppe_missing locally.
      if (entry.ppeMissing) {
        const driverName = store.drivers.find((d) => d.id === driverId)?.name ?? "A driver";
        notifyAllAdminsMock(
          store,
          "alert",
          `${driverName} reported missing PPE at start of shift: ${entry.ppeMissingReason}`,
          "/admin/timesheets",
        );
      }
    }
    store.submitStartOfDay(entry);
    // Vehicle issue reporting destination (Driver item 14): a "minor" or
    // "major" condition report used to just flag the time_entries row —
    // nobody downstream ever saw it unless an admin happened to open that
    // driver's timesheet. This routes it to the same mechanic work-order
    // queue that failed pre-trip inspections already auto-open into (see
    // auto_open_wo_from_failed_inspection in
    // 20260602150128_build_maintenance_wo_and_ticket_uses.sql), giving the
    // "notify management" promise on the major-issue option something real
    // to do. reportedFrom: 'driver_note' is a value that migration's CHECK
    // constraint + RLS already reserved for exactly this — the schema was
    // ready, only the client wiring was missing. Best-effort: a driver's
    // shift must never fail to submit because the WO side-effect hiccuped.
    if (p.condition !== "ok" && vehicleId) {
      try {
        await api.createMaintenanceWorkOrder({
          vehicleId,
          issueDescription: p.conditionNote?.trim() || `Driver-reported ${p.condition} issue at start of shift`,
          priority: p.condition === "major" ? "critical" : "medium",
          reportedBy: driverId,
          reportedFrom: "driver_note",
          idempotencyKey: p.idempotencyKey ? `${p.idempotencyKey}-wo` : undefined,
        });
      } catch (err) {
        void reportErrorToServer({
          severity: "error",
          errorCode: "SUBMIT_START_OF_DAY_WO",
          message: err instanceof Error ? err.message : String(err),
          context: { driverId, vehicleId },
        });
      }
    }
    return entry;
  },
  submitEndOfDay: async (p: {
    driverId: string;
    odometer: number;
    fuelLevel: string;
    summary: string;
    gps: { lat: number; lng: number } | null;
    idempotencyKey?: string;
  }) => {
    if (USE_SUPABASE && supabase) {
      // Resolve the REAL driver uuid — a /t/<token> session carries it in
      // sessionStorage; AuthContext otherwise leaves user.id at the mock "A-01",
      // which is not a valid uuid and 500s the driver_id filter below.
      const driverId = await currentActorId();
      if (!driverId) throw new Error("submitEndOfDay: no authenticated actor");
      // Find the driver's open shift (clock_out IS NULL). Most-recent wins so
      // a stale row from a forgotten clock-out doesn't get re-closed in front
      // of today's row.
      const { data: open, error: selErr } = await supabase
        .from("time_entries")
        .select("*")
        .eq("driver_id", driverId)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (selErr)
        throw new Error(
          `submitEndOfDay.select: ${reportApiError("SUBMIT_END_OF_DAY_SELECT", selErr, { driverId })}`,
        );
      if (!open) {
        // Surface as an error so the offline-queue can move it to dead-letter
        // rather than silently losing the EOD payload.
        throw new Error("submitEndOfDay: no open shift");
      }
      const clockOutIso = new Date().toISOString();
      const { error: updErr } = await supabase
        .from("time_entries")
        .update({
          clock_out: clockOutIso,
          gps_clock_out_lat: p.gps?.lat ?? null,
          gps_clock_out_lng: p.gps?.lng ?? null,
        })
        .eq("id", open.id);
      if (updErr)
        throw new Error(
          `submitEndOfDay.update: ${reportApiError("SUBMIT_END_OF_DAY_UPDATE", updErr, { driverId, entryId: open.id, idempotencyKey: p.idempotencyKey ?? null })}`,
        );
      getStore().submitEndOfDay(open.id, { clockOut: clockOutIso, gpsClockOut: p.gps });
    } else {
      await wait();
      const s = getStore();
      const openLocal = s.timeEntries.find((t) => t.driverId === p.driverId && !t.clockOut);
      if (openLocal)
        s.submitEndOfDay(openLocal.id, {
          clockOut: new Date().toISOString(),
          gpsClockOut: p.gps,
        });
    }
    return { ok: true };
  },
  submitToolChecklist: async (
    input: Omit<ToolChecklistSubmission, "id" | "submittedAt"> & {
      items: ToolChecklistItem[];
      idempotencyKey?: string;
    },
  ) => {
    const s: ToolChecklistSubmission = {
      ...input,
      id: uid("TCS"),
      submittedAt: new Date().toISOString(),
    };
    if (USE_SUPABASE && supabase) {
      // Override the (possibly mock "A-01") driver id with the real actor uuid.
      const actorId = await currentActorId();
      if (!actorId) throw new Error("submitToolChecklist: no authenticated actor");
      s.driverId = actorId; // keep the local-store mirror consistent too
      try {
        await insertWithIdempotency("tool_checklist_submissions", {
          id: s.id,
          driver_id: s.driverId,
          vehicle_id: s.vehicleId,
          kind: s.kind,
          submitted_at: s.submittedAt,
          gps_lat: s.gpsLat,
          gps_lng: s.gpsLng,
          idempotency_key: input.idempotencyKey,
        });
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitToolChecklist: ${reportApiError("SUBMIT_TOOL_CHECKLIST", e, { submissionId: s.id })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().submitToolChecklist(s);
    return s;
  },

  // Time tracking
  //
  // clockIn / clockOut are the bare in-app shift controls surfaced by the
  // DriverLayout (Clock-in modal). They share the same time_entries table as
  // submitStartOfDay / submitEndOfDay — the difference is just that they're
  // not gated on the start/end-of-day form ceremony. Both paths now persist
  // to Supabase so payroll, QBO, and the admin timesheet view see the same
  // rows regardless of which entry point the driver used.
  clockIn: async (
    driverId: string,
    gps: { lat: number; lng: number } | null,
    _odometer: number,
  ) => {
    const entry: TimeEntry = {
      id: uid("TE"),
      driverId,
      clockIn: new Date().toISOString(),
      clockOut: null,
      gpsClockIn: gps,
      gpsClockOut: null,
      vehicleMovementCorrelation: "pending",
      flagged: false,
      flagReason: "",
    };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("time_entries").insert({
        id: entry.id,
        driver_id: entry.driverId,
        clock_in: entry.clockIn,
        clock_out: null,
        gps_clock_in_lat: entry.gpsClockIn?.lat ?? null,
        gps_clock_in_lng: entry.gpsClockIn?.lng ?? null,
        gps_clock_out_lat: null,
        gps_clock_out_lng: null,
        vehicle_movement_correlation: entry.vehicleMovementCorrelation,
        flagged: entry.flagged,
        flag_reason: entry.flagReason,
        pretrip_inspection_id: null,
      });
      if (error)
        throw new Error(
          `clockIn: ${reportApiError("CLOCK_IN", error, { driverId, entryId: entry.id })}`,
        );
    } else {
      await wait();
    }
    getStore().clockIn(entry);
    return entry;
  },
  clockOut: async (
    entryId: string,
    gps: { lat: number; lng: number } | null,
    _odometer: number,
  ) => {
    const clockOutIso = new Date().toISOString();
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("time_entries")
        .update({
          clock_out: clockOutIso,
          gps_clock_out_lat: gps?.lat ?? null,
          gps_clock_out_lng: gps?.lng ?? null,
        })
        .eq("id", entryId);
      if (error) throw new Error(`clockOut: ${reportApiError("CLOCK_OUT", error, { entryId })}`);
    } else {
      await wait();
    }
    getStore().clockOut(entryId, { clockOut: clockOutIso, gpsClockOut: gps });
    return { ok: true };
  },

  // Vehicle inspection
  submitVehicleInspection: async (
    input: Omit<VehicleInspection, "id" | "submittedAt"> & { idempotencyKey?: string },
  ) => {
    const store = getStore();
    const now = new Date();
    const nowIso = now.toISOString();
    // Only PASSING inspections get the synthetic backdate. A failed walk-around
    // recorded at "now" is the truthful audit trail.
    const { inspectionMinDurationSeconds: minSec, inspectionMaxDurationSeconds: maxSec } =
      store.appSettings;
    const lo = Math.max(0, Math.min(minSec, maxSec));
    const hi = Math.max(lo, Math.max(minSec, maxSec));
    const submittedAt = input.flagged
      ? nowIso
      : new Date(
          now.getTime() - (lo + Math.floor(Math.random() * (hi - lo + 1))) * 1000,
        ).toISOString();
    const inspection: VehicleInspection = {
      ...input,
      id: uid("INS"),
      submittedAt,
    };

    if (USE_SUPABASE && supabase) {
      // Override the (possibly mock "A-01") driver id with the real actor uuid.
      const actorId = await currentActorId();
      if (!actorId) throw new Error("submitVehicleInspection: no authenticated actor");
      inspection.driverId = actorId; // keep the local-store mirror consistent too
      let dedupedToExisting = false;
      let effectiveInspectionId = inspection.id;
      try {
        const persisted = await insertWithIdempotency("vehicle_inspections", {
          id: inspection.id,
          driver_id: inspection.driverId,
          vehicle_id: inspection.vehicleId,
          submitted_at: inspection.submittedAt,
          gps_lat: inspection.gpsCapture?.lat ?? null,
          gps_lng: inspection.gpsCapture?.lng ?? null,
          gps_captured_at: inspection.gpsCapture?.capturedAt ?? null,
          geotab_lat: inspection.geotabSnapshot?.lat ?? null,
          geotab_lng: inspection.geotabSnapshot?.lng ?? null,
          geotab_captured_at: inspection.geotabSnapshot?.capturedAt ?? null,
          geotab_distance_meters: inspection.geotabSnapshot?.distanceMeters ?? null,
          notes: inspection.notes,
          photos: inspection.photos,
          flagged: inspection.flagged,
          idempotency_key: input.idempotencyKey,
        });
        // When the helper detected a 23505 collision and returned the
        // already-present row, its id may differ from our freshly minted
        // uid("INS"). Adopt the persisted id so the local store mirror and
        // the (skipped) inspection_items insert reference the canonical row.
        const persistedRow = persisted as { id?: string };
        if (persistedRow.id && persistedRow.id !== inspection.id) {
          dedupedToExisting = true;
          effectiveInspectionId = persistedRow.id;
          inspection.id = persistedRow.id;
        }
      } catch (insErr) {
        const e = insErr as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitVehicleInspection: ${reportApiError("SUBMIT_VEHICLE_INSPECTION", e, { inspectionId: inspection.id })}`,
        );
      }
      // On a deduped replay the inspection_items rows were already inserted
      // by the original successful attempt — re-inserting would either
      // duplicate them (no unique constraint on the child table) or trip
      // a fk/pk error if one existed. Skip the children insert in that case.
      if (!dedupedToExisting && inspection.items.length) {
        const { error: itemsErr } = await supabase.from("inspection_items").insert(
          inspection.items.map((it) => ({
            inspection_id: effectiveInspectionId,
            name: it.name,
            status: it.status,
            notes: it.notes,
          })),
        );
        if (itemsErr)
          throw new Error(
            `submitVehicleInspection.items: ${reportApiError("SUBMIT_VEHICLE_INSPECTION_ITEMS", itemsErr, { inspectionId: inspection.id })}`,
          );
      }
      // No client-side vehicles UPDATE — drivers don't have RLS write access
      // on vehicles, and the trg_vehicles_set_last_pretrip trigger on
      // vehicle_inspections INSERT stamps last_pretrip_at server-side for
      // passing inspections. Server-authoritative + bypass-proof.
    } else {
      await wait();
    }

    store.submitVehicleInspection(inspection);
    if (!inspection.flagged) {
      store.setVehicleLastPretrip(inspection.vehicleId, nowIso);
    }
    return inspection;
  },

  // Mechanic
  //
  // The mechanic form now runs an inline inventory search before submit and
  // hands us the matching rows in `inventoryCheckResult`. We persist that
  // snapshot to `purchase_requests.inventory_check_result` (jsonb) so admins
  // reviewing the PR can see exactly what was on hand at submission — no
  // "did we already have these?" guesswork. An empty array means we checked
  // and found nothing; null means the mechanic never toggled the check.
  submitPurchaseRequest: async (
    input: Omit<PurchaseRequest, "id" | "createdAt" | "status"> & { idempotencyKey?: string },
  ) => {
    const pr: PurchaseRequest = {
      ...input,
      id: uid("PR"),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    if (USE_SUPABASE && supabase) {
      // Override the (possibly mock "A-01") mechanic id with the real actor uuid.
      const actorId = await currentActorId();
      if (!actorId) throw new Error("submitPurchaseRequest: no authenticated actor");
      pr.mechanicId = actorId; // keep the local-store mirror consistent too
      try {
        await insertWithIdempotency("purchase_requests", {
          id: pr.id,
          mechanic_id: pr.mechanicId,
          item: pr.item,
          quantity: pr.quantity,
          reason: pr.reason,
          estimated_cost: pr.estimatedCost,
          urgency: pr.urgency,
          inventory_checked_at: pr.inventoryCheckedAt,
          // jsonb column: pg-js will JSON.stringify for us. Pass null when the
          // mechanic skipped the check so we can distinguish "didn't bother"
          // from "checked, no matches" (empty array). The strict domain
          // interface doesn't structurally satisfy Supabase's recursive Json
          // type (no index signature), so we go through `unknown` — runtime
          // shape is plain JSON-safe scalars regardless.
          inventory_check_result: serializeInventoryCheckResult(pr.inventoryCheckResult),
          status: pr.status,
          approved_by: pr.approvedBy,
          supplier_id: pr.supplierId,
          created_at: pr.createdAt,
          idempotency_key: input.idempotencyKey,
        });
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `submitPurchaseRequest: ${reportApiError("SUBMIT_PURCHASE_REQUEST", e, { purchaseRequestId: pr.id })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().submitPurchaseRequest(pr);
    return pr;
  },
  /**
   * Approve a purchase request AND, when the requested item exists in stock
   * with at least one free unit, reserve against it — up to `pr.quantity`,
   * capped by what's actually free (qty_on_hand - qty_reserved). A request
   * for 4 against 2 free units reserves 2 (partial coverage), not a flat 1.
   * The PR row stores the reservation quantity (`inventory_decrement_qty`)
   * so the admin sheet can render "Reserved 2 of 4 requested" — and so the
   * later markPurchaseRequestOrdered call knows not to double-debit.
   *
   * Match strategy mirrors the mechanic-side `inventory_check_result` lookup:
   * case-insensitive substring on either `name` or `sku`. Best match by
   * shortest name (a tighter substring hit beats a loose one). When nothing
   * matches OR every match is exhausted (qty_on_hand - qty_reserved < 1),
   * we still flip status to 'approved' but record qty 0 — admin still needs
   * to mark ordered after placing a real supplier order.
   */
  approvePurchaseRequest: async (id: string, approverId: string) => {
    const store = getStore();
    const pr = store.purchaseRequests.find((p) => p.id === id);
    if (!pr) throw new Error(`approvePurchaseRequest: PR ${id} not found`);

    if (USE_SUPABASE && supabase) {
      // Single atomic call: SECURITY DEFINER RPC locks the PR row + matching
      // inventory row, decrements qty_reserved iff stock available, flips
      // status to approved, all in one transaction. Idempotent against
      // double-clicks: a second caller gets ok=false back with the current
      // status (no side effects). Replaces the previous 3-round-trip
      // open-coded version which could double-reserve on double-click and
      // strand qty_reserved if the PR update failed after the inventory bump.
      const { data, error } = await supabase.rpc("approve_purchase_request", {
        p_id: id,
        p_approver_id: approverId,
      });
      if (error)
        throw new Error(
          `approvePurchaseRequest: ${reportApiError("APPROVE_PR", error, { purchaseRequestId: id })}`,
        );
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.ok) {
        // Lost the race against another admin or a previous click. Surface
        // the current status so the UI can refresh without throwing.
        return {
          ok: false as const,
          alreadyHandled: true as const,
          currentStatus: row?.pr_status ?? "approved",
          reservedInventory: null,
        };
      }
      const reservation =
        row.inventory_decrement_qty > 0 && row.matched_inventory_id
          ? { itemId: row.matched_inventory_id, qty: row.inventory_decrement_qty }
          : null;
      if (reservation) store.adjustInventoryReservation(reservation.itemId, reservation.qty);
      store.approvePurchaseRequest(id, approverId, reservation);
      return { ok: true as const, reservedInventory: reservation };
    }

    // Mock path: keep the open-coded inventory match for the demo-without-Supabase case.
    const needle = pr.item.trim().toLowerCase();
    const candidates = needle
      ? store.inventoryItems.filter(
          (it) =>
            !it.archived &&
            (it.name.toLowerCase().includes(needle) ||
              needle.includes(it.name.toLowerCase()) ||
              it.sku.toLowerCase().includes(needle) ||
              needle.includes(it.sku.toLowerCase())),
        )
      : [];
    const matched =
      candidates
        .filter((it) => it.qtyOnHand - it.qtyReserved >= 1)
        .sort((a, b) => a.name.length - b.name.length)[0] ?? null;
    const reservation = matched
      ? { itemId: matched.id, qty: Math.min(matched.qtyOnHand - matched.qtyReserved, pr.quantity) }
      : null;
    await wait();
    if (reservation) store.adjustInventoryReservation(reservation.itemId, reservation.qty);
    store.approvePurchaseRequest(id, approverId, reservation);
    return { ok: true as const, reservedInventory: reservation };
  },

  /**
   * Place the supplier order for a previously-approved PR. Stamps the
   * status to 'ordered' along with audit metadata (orderer + supplier ref +
   * timestamp). Inventory was already reserved at approval, so this is
   * pure bookkeeping — no stock movement.
   *
   * Throws when the PR isn't in 'approved' status so we can't accidentally
   * order a rejected or already-ordered request from a stale UI.
   */
  markPurchaseRequestOrdered: async (id: string, supplierOrderRef: string) => {
    const ref = supplierOrderRef.trim();
    if (!ref) throw new Error("markPurchaseRequestOrdered: supplierOrderRef is required");
    const store = getStore();
    const pr = store.purchaseRequests.find((p) => p.id === id);
    if (!pr) throw new Error(`markPurchaseRequestOrdered: PR ${id} not found`);
    if (pr.status !== "approved")
      throw new Error(`markPurchaseRequestOrdered: PR ${id} is ${pr.status}, must be approved`);

    // Best-effort grab of the calling user id for the audit trail. When
    // running on mocks we fall back to the approver so the row still has a
    // sensible "ordered_by" without forcing the caller to pass it in.
    let ordererId: string = pr.approvedBy ?? "";
    const orderedAt = new Date().toISOString();

    if (USE_SUPABASE && supabase) {
      try {
        const { data } = await supabase.auth.getUser();
        if (data.user?.id) ordererId = data.user.id;
      } catch {
        // Keep the approver fallback — RLS will still gate the UPDATE.
      }
      const { error } = await supabase
        .from("purchase_requests")
        .update({
          status: "ordered",
          ordered_at: orderedAt,
          ordered_by: ordererId || null,
          supplier_order_ref: ref,
        })
        .eq("id", id)
        .eq("status", "approved"); // belt-and-braces: don't clobber a row that raced
      if (error)
        throw new Error(
          `markPurchaseRequestOrdered: ${reportApiError("MARK_PR_ORDERED", error, { purchaseRequestId: id })}`,
        );
    } else {
      await wait();
    }
    store.markPurchaseRequestOrdered(id, ordererId, ref);
    return { ok: true as const, orderedAt, supplierOrderRef: ref };
  },

  // Integrations
  sendSms: async (driverId: string, body: string, jobId?: string): Promise<SmsLog | null> => {
    // Never invoke the edge function with an empty/invalid number: it just
    // returns 400 "Missing required field: to" (or a Twilio 400), which
    // supabase-js surfaces as the opaque "Edge Function returned a non-2xx
    // status code" and would hard-fail the caller. A missing driver phone is a
    // data gap, not an error — return null so callers can skip cleanly.
    const driverPhone = getStore()
      .drivers.find((d) => d.id === driverId)
      ?.phone?.trim();
    const E164 = /^\+[1-9]\d{7,14}$/;
    if (!driverPhone || !E164.test(driverPhone)) {
      console.warn(`sendSms: skipping — driver ${driverId} has no valid E.164 phone`);
      return null;
    }
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.functions.invoke<{ smsLog: SmsLogRow }>(
        "twilio-send-sms",
        {
          body: {
            to: driverPhone,
            body,
            driverId,
            jobId: jobId ?? null,
          },
        },
      );
      if (error)
        throw new Error(
          `sendSms: ${reportApiError("SEND_SMS", error, { driverId, jobId: jobId ?? null })}`,
        );
      const row = data?.smsLog;
      const sms: SmsLog = row
        ? {
            id: row.id,
            driverId: row.driver_id ?? driverId,
            jobId: row.job_id,
            body: row.body,
            sentAt: row.sent_at ?? new Date().toISOString(),
            twilioMessageId: row.twilio_message_id,
            deliveryStatus: row.delivery_status,
          }
        : {
            id: uid("SMS"),
            driverId,
            jobId: jobId ?? null,
            body,
            sentAt: new Date().toISOString(),
            twilioMessageId: null,
            deliveryStatus: "sent",
          };
      getStore().addSms(sms);
      return sms;
    }
    const sms: SmsLog = {
      id: uid("SMS"),
      driverId,
      jobId: jobId ?? null,
      body,
      sentAt: new Date().toISOString(),
      twilioMessageId: `SM${Math.random().toString(36).slice(2, 8)}`,
      deliveryStatus: "sent",
    };
    await wait(100);
    getStore().addSms(sms);
    return sms;
  },
  fetchGeotabLocation: async (vehicleId: string) => {
    if (USE_SUPABASE && supabase) {
      // Read straight from vehicles. The pg_cron keeps these columns fresh
      // by invoking geotab-sync-locations every ~60s; calling the edge
      // function on every map tick would be wasteful and rate-limit prone.
      const { data, error } = await supabase
        .from("vehicles")
        .select("latitude, longitude, last_seen_at")
        .eq("id", vehicleId)
        .maybeSingle();
      if (error)
        throw new Error(
          `fetchGeotabLocation: ${reportApiError("FETCH_GEOTAB_LOCATION", error, { vehicleId })}`,
        );
      if (data?.latitude != null && data?.longitude != null) {
        return {
          lat: data.latitude,
          lng: data.longitude,
          capturedAt: data.last_seen_at ?? new Date().toISOString(),
        };
      }
      // Not mapped to a Geotab device yet — fall through to mock so the
      // map still shows something rather than failing.
      const cached = geotabCoordsForVehicle(vehicleId) ?? { lat: 43.6532, lng: -79.3832 };
      return { lat: cached.lat, lng: cached.lng, capturedAt: new Date().toISOString() };
    }
    await wait(80);
    const coords = geotabCoordsForVehicle(vehicleId) ?? { lat: 43.6532, lng: -79.3832 };
    // Add a tiny stable jitter so the position looks "live" without breaking distance checks
    const jitter = (vehicleId.charCodeAt(0) % 5) * 0.00002;
    return {
      lat: coords.lat + jitter,
      lng: coords.lng - jitter,
      capturedAt: new Date(
        Date.now() - 60_000 - (vehicleId.charCodeAt(0) % 5) * 60_000,
      ).toISOString(),
    };
  },
  fetchGeotabTelematics: async (vehicleId: string) => {
    if (USE_SUPABASE && supabase) {
      // The Geotab cron writes vehicles.odometer + vehicles.engine_hours from
      // StatusData diagnostic samples (see geotab-sync-locations), so a read
      // from the vehicles row is the freshest source. Avoids round-tripping
      // through the edge function on every call site.
      const { data, error } = await supabase
        .from("vehicles")
        .select("odometer, engine_hours")
        .eq("id", vehicleId)
        .maybeSingle();
      if (error)
        throw new Error(
          `fetchGeotabTelematics: ${reportApiError("FETCH_GEOTAB_TELEMATICS", error, { vehicleId })}`,
        );
      return {
        odometer: data?.odometer ?? 0,
        engineHours: data?.engine_hours ?? 0,
      };
    }
    // Mock mode: keep the zero-stub so existing UI tests don't depend on
    // synthetic telematics values.
    await wait(50);
    return { odometer: 0, engineHours: 0 };
  },

  // ---- Maintenance + fuel logs -----------------------------------------
  // The mechanic (and admin from the vehicle detail page) can record
  // service work and fuel-up entries. Both insert to Supabase when wired
  // up and mirror to the local store so the tables refresh immediately.
  addMaintenanceLog: async (input: Omit<MaintenanceLog, "id">) => {
    const log: MaintenanceLog = { ...input, id: uid("MAINT") };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("maintenance_logs")
        .insert(domainMaintenanceLogToDb(log));
      if (error)
        throw new Error(
          `addMaintenanceLog: ${reportApiError("ADD_MAINTENANCE_LOG", error, { maintenanceLogId: log.id, vehicleId: log.vehicleId })}`,
        );
    } else {
      await wait();
    }
    getStore().addMaintenanceLog(log);
    return log;
  },
  addFuelLog: async (input: Omit<FuelLog, "id">) => {
    const log: FuelLog = { ...input, id: uid("FUEL") };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("fuel_logs").insert(domainFuelLogToDb(log));
      if (error)
        throw new Error(
          `addFuelLog: ${reportApiError("ADD_FUEL_LOG", error, { fuelLogId: log.id, vehicleId: log.vehicleId })}`,
        );
    } else {
      await wait();
    }
    getStore().addFuelLog(log);
    return log;
  },

  // ---- Vehicle tools ------------------------------------------------------
  // Client feedback: the vehicle detail page could only display the tool
  // roster assigned via seed data — there was no way to add, edit, reassign,
  // or retire one. RLS already lets admin and mechanic write this table (see
  // tools_admin_all / tools_mechanic_all in 20260601180203_rls_policies.sql);
  // this was purely a missing UI + API surface, no schema/policy change
  // needed.
  createTool: async (input: {
    name: string;
    condition: ToolCondition;
    vehicleId: string | null;
  }): Promise<Tool> => {
    const tool: Tool = { ...input, id: uid("TL") };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("tools").insert(domainToolToDb(tool));
      if (error)
        throw new Error(
          `createTool: ${reportApiError("CREATE_TOOL", error, { toolId: tool.id })}`,
        );
    } else {
      await wait();
    }
    getStore().addTool(tool);
    return tool;
  },
  updateTool: async (
    id: string,
    patch: Partial<Pick<Tool, "name" | "condition" | "vehicleId">>,
  ): Promise<void> => {
    if (USE_SUPABASE && supabase) {
      const dbPatch: Update<"tools"> = {};
      if (patch.name !== undefined) dbPatch.name = patch.name;
      if (patch.condition !== undefined) dbPatch.condition = patch.condition;
      if (patch.vehicleId !== undefined) dbPatch.vehicle_id = patch.vehicleId;
      const { error } = await supabase.from("tools").update(dbPatch).eq("id", id);
      if (error)
        throw new Error(`updateTool: ${reportApiError("UPDATE_TOOL", error, { toolId: id })}`);
    } else {
      await wait();
    }
    getStore().patchTool(id, patch);
  },
  deleteTool: async (id: string): Promise<void> => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("tools").delete().eq("id", id);
      if (error)
        throw new Error(`deleteTool: ${reportApiError("DELETE_TOOL", error, { toolId: id })}`);
    } else {
      await wait();
    }
    getStore().removeTool(id);
  },

  // ---- Maintenance work orders (mechanic queue) ------------------------
  //
  // Surface backed by public.maintenance_work_orders. DataContext keeps the
  // local mirror fresh via the realtime subscription, so the listing helper
  // is just a thin readthrough on top of the store — no extra fetch needed.
  // claim/update/create persist to Supabase and mirror the new row into the
  // store so the UI updates without waiting on the realtime tick.
  listMaintenanceWorkOrders: (): MaintenanceWorkOrder[] => {
    return getStore().maintenanceWorkOrders;
  },

  /**
   * Atomic mechanic claim of a queued maintenance work order. Delegates to
   * the SECURITY DEFINER claim_maintenance_work_order RPC which row-locks
   * the target and refuses to re-claim a row that's already taken — so two
   * mechanics racing on the same queued WO get exactly one winner. On a
   * lost race we surface the rpc's error message and let the caller toast
   * "already claimed by …" rather than silently double-assigning.
   */
  claimMaintenanceWorkOrder: async (id: string, mechanicId: string) => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.rpc("claim_maintenance_work_order", {
        p_id: id,
        p_mechanic_id: mechanicId,
      });
      if (error)
        throw new Error(
          `claimMaintenanceWorkOrder: ${reportApiError("CLAIM_MAINTENANCE_WO", error, { id, mechanicId })}`,
        );
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.ok) {
        // RPC returns { ok=false, status, assigned_mechanic_id, error } when
        // the row has already been claimed by someone else. Propagate the
        // server message verbatim so the toast says "already claimed".
        throw new Error(row?.error ?? "claim_maintenance_work_order failed");
      }
      // Re-fetch the canonical row so the local mirror matches the DB —
      // a 'claimed' status with the freshly-stamped claimed_at timestamp.
      const { data: fresh, error: selErr } = await supabase
        .from("maintenance_work_orders")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (selErr || !fresh) {
        // Realtime will reconcile shortly — log and move on rather than
        // throwing, since the claim itself succeeded.
        void reportApiError("CLAIM_MAINTENANCE_WO_REFETCH", selErr, { id });
        return { ok: true as const };
      }
      getStore().upsertMaintenanceWorkOrder(dbMaintenanceWorkOrderToDomain(fresh));
      return { ok: true as const };
    }
    await wait();
    const store = getStore();
    const existing = store.maintenanceWorkOrders.find((w) => w.id === id);
    if (!existing) throw new Error(`maintenance work order ${id} not found`);
    if (existing.status !== "queued" || existing.assignedMechanicId !== null) {
      throw new Error("already claimed");
    }
    const claimed: MaintenanceWorkOrder = {
      ...existing,
      status: "claimed",
      assignedMechanicId: mechanicId,
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.upsertMaintenanceWorkOrder(claimed);
    return { ok: true as const };
  },

  /**
   * Patch a maintenance work order the calling mechanic owns. RLS gates the
   * UPDATE on `assigned_mechanic_id = auth.uid()` (see migration), so the
   * client-side .eq("assigned_mechanic_id", mechanicId) is belt-and-braces:
   * an admin doing the same patch from /admin/* will hit the
   * `maintenance_wo_admin_all` policy instead, but mechanics MUST narrow.
   *
   * Supported patches: status flips (queued/claimed/in_progress/completed/
   * cancelled), labor capture, parts_used jsonb, finalCost, completionNotes,
   * startedAt/completedAt stamps. Release back to queue (assignedMechanicId
   * null + claimedAt null + status='queued') is handled by passing the
   * appropriate fields explicitly.
   */
  updateMaintenanceWorkOrder: async (
    id: string,
    patch: {
      status?: MaintenanceWorkOrderStatus;
      assignedMechanicId?: string | null;
      claimedAt?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
      laborHours?: number;
      laborNotes?: string;
      partsUsed?: MaintenanceWorkOrderPart[];
      finalCost?: number | null;
      completionNotes?: string | null;
    },
    mechanicId: string,
  ) => {
    if (USE_SUPABASE && supabase) {
      // Build the Update payload via spread-conditional so only keys the
      // caller passed land on the row — passing `undefined` would have
      // Supabase null-stamp the column. Typed against the generated
      // table-Update shape so excess-properties checks stay strict.
      const update: import("./database.types").Database["public"]["Tables"]["maintenance_work_orders"]["Update"] =
        {
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.assignedMechanicId !== undefined && {
            assigned_mechanic_id: patch.assignedMechanicId,
          }),
          ...(patch.claimedAt !== undefined && { claimed_at: patch.claimedAt }),
          ...(patch.startedAt !== undefined && { started_at: patch.startedAt }),
          ...(patch.completedAt !== undefined && { completed_at: patch.completedAt }),
          ...(patch.laborHours !== undefined && { labor_hours: patch.laborHours }),
          ...(patch.laborNotes !== undefined && { labor_notes: patch.laborNotes }),
          ...(patch.partsUsed !== undefined && {
            parts_used: JSON.parse(
              JSON.stringify(patch.partsUsed),
            ) as import("./database.types").Json,
          }),
          ...(patch.finalCost !== undefined && { final_cost: patch.finalCost }),
          ...(patch.completionNotes !== undefined && {
            completion_notes: patch.completionNotes,
          }),
        };
      // Releasing back to the queue: the mechanic explicitly nulls
      // assigned_mechanic_id. The `.eq(mechanicId)` guard on the WHERE
      // would otherwise still apply because the row STILL belongs to them
      // at the moment of UPDATE — RLS evaluates USING against the old row.
      const { data, error } = await supabase
        .from("maintenance_work_orders")
        .update(update)
        .eq("id", id)
        .eq("assigned_mechanic_id", mechanicId)
        .select()
        .maybeSingle();
      if (error) {
        // Treat any Postgres-level error as a generic operation failure. We
        // previously string-matched "policy" / "row-level security" in the
        // error blob to auto-map RLS denials to a typed reassigned error, but
        // that heuristic fires on legitimate WITH CHECK failures unrelated to
        // reassignment (e.g. release-back paths trying to null
        // assigned_mechanic_id while still owning the row), producing false
        // "reassigned" toasts. The reassigned case is now exclusively detected
        // via the !data probe path below — that's the only signal we can
        // trust to mean "the row exists but is no longer ours".
        throw new Error(
          `updateMaintenanceWorkOrder: ${reportApiError("UPDATE_MAINTENANCE_WO", error, { id, mechanicId })}`,
        );
      }
      if (!data) {
        // The id matched a row but the assigned_mechanic_id filter excluded
        // it: someone reassigned this WO out from under us. Verify by a
        // bare-id select so we don't lie about it being "not found".
        const { data: probe } = await supabase
          .from("maintenance_work_orders")
          .select("id")
          .eq("id", id)
          .maybeSingle();
        if (probe) {
          throw new MaintenanceWorkOrderError("reassigned", "Work order was reassigned");
        }
        throw new Error("updateMaintenanceWorkOrder: row not found or not owned by mechanic");
      }
      getStore().upsertMaintenanceWorkOrder(dbMaintenanceWorkOrderToDomain(data));
      return { ok: true as const };
    }
    await wait();
    const store = getStore();
    const existing = store.maintenanceWorkOrders.find((w) => w.id === id);
    if (!existing) throw new Error(`maintenance work order ${id} not found`);
    if (existing.assignedMechanicId !== mechanicId) {
      throw new Error("not your work order");
    }
    const next: MaintenanceWorkOrder = {
      ...existing,
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.assignedMechanicId !== undefined && {
        assignedMechanicId: patch.assignedMechanicId,
      }),
      ...(patch.claimedAt !== undefined && { claimedAt: patch.claimedAt }),
      ...(patch.startedAt !== undefined && { startedAt: patch.startedAt }),
      ...(patch.completedAt !== undefined && { completedAt: patch.completedAt }),
      ...(patch.laborHours !== undefined && { laborHours: patch.laborHours }),
      ...(patch.laborNotes !== undefined && { laborNotes: patch.laborNotes }),
      ...(patch.partsUsed !== undefined && { partsUsed: patch.partsUsed }),
      ...(patch.finalCost !== undefined && { finalCost: patch.finalCost }),
      ...(patch.completionNotes !== undefined && { completionNotes: patch.completionNotes }),
      updatedAt: new Date().toISOString(),
    };
    store.upsertMaintenanceWorkOrder(next);
    return { ok: true as const };
  },

  /**
   * Terminal WO completion — separate from updateMaintenanceWorkOrder's
   * generic progress-save patch because this one has a side effect that
   * must happen EXACTLY once: consuming qty_on_hand for every part recorded
   * against the job. Delegates to the SECURITY DEFINER
   * complete_maintenance_work_order RPC (row-locks + an idempotent
   * status-check), same pattern as claim/release — see
   * 20260717150000_complete_wo_consumes_parts.sql. A retried call (network
   * blip, double-tap) sees the already-completed row and does not
   * double-decrement stock.
   */
  completeMaintenanceWorkOrder: async (
    id: string,
    mechanicId: string,
    patch: {
      laborHours: number;
      laborNotes: string;
      partsUsed: MaintenanceWorkOrderPart[];
      finalCost: number | null;
      completionNotes: string | null;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.rpc("complete_maintenance_work_order", {
        p_id: id,
        p_mechanic_id: mechanicId,
        p_labor_hours: patch.laborHours,
        p_labor_notes: patch.laborNotes,
        p_parts_used: patch.partsUsed as unknown as import("./database.types").Json,
        p_final_cost: patch.finalCost,
        p_completion_notes: patch.completionNotes,
      });
      if (error) {
        return {
          ok: false,
          reason: reportApiError("COMPLETE_MAINTENANCE_WO", error, { id, mechanicId }),
        };
      }
      const row = (Array.isArray(data) ? data[0] : data) as
        | { ok: boolean; status: string }
        | undefined;
      if (!row?.ok) {
        return { ok: false, reason: "Work order is not assigned to you" };
      }
      // The RPC doesn't hand back the full row — re-fetch the one we just
      // touched (a single-row select, not a refetch of the whole queue) so
      // the local mirror reflects the server's final state exactly.
      const { data: fresh } = await supabase
        .from("maintenance_work_orders")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (fresh) getStore().upsertMaintenanceWorkOrder(dbMaintenanceWorkOrderToDomain(fresh));
      return { ok: true };
    }
    // Mock mode: mirror the RPC's side effects locally.
    await wait();
    const store = getStore();
    const existing = store.maintenanceWorkOrders.find((w) => w.id === id);
    if (!existing) return { ok: false, reason: "Work order not found" };
    if (existing.assignedMechanicId !== mechanicId) {
      return { ok: false, reason: "Work order is not assigned to you" };
    }
    if (existing.status === "completed") return { ok: true };
    // BOM-aware, mirroring complete_maintenance_work_order's SQL: a part
    // flagged isBom carries no real stock of its own — decrement its
    // components (scaled by qty_per * qty used) instead of the BOM row.
    for (const part of patch.partsUsed) {
      const item = store.inventoryItems.find((i) => i.id === part.inventoryItemId);
      if (!item) continue;
      if (item.isBom) {
        const recipe = store.bomComponents.filter((c) => c.parentItemId === item.id);
        for (const comp of recipe) {
          const compItem = store.inventoryItems.find((i) => i.id === comp.componentItemId);
          if (!compItem) continue;
          const newQty = Math.max(0, compItem.qtyOnHand - comp.qtyPer * part.qty);
          maybeNotifyLowStockMock(store, compItem, newQty, compItem.reorderPoint);
          store.applyInventoryItem({ ...compItem, qtyOnHand: newQty });
        }
      } else {
        const newQty = Math.max(0, item.qtyOnHand - part.qty);
        maybeNotifyLowStockMock(store, item, newQty, item.reorderPoint);
        store.applyInventoryItem({ ...item, qtyOnHand: newQty });
      }
    }
    store.upsertMaintenanceWorkOrder({
      ...existing,
      status: "completed",
      completedAt: new Date().toISOString(),
      laborHours: patch.laborHours,
      laborNotes: patch.laborNotes,
      partsUsed: patch.partsUsed,
      finalCost: patch.finalCost,
      completionNotes: patch.completionNotes,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true };
  },

  /**
   * Release a claimed / in_progress maintenance WO back to the queue.
   *
   * Delegates to the SECURITY DEFINER release_maintenance_work_order RPC which
   * atomically sets status='queued', assigned_mechanic_id=NULL, claimed_at=NULL,
   * started_at=NULL in one transaction. The RPC is required because the
   * mechanic UPDATE policy's WITH CHECK clause (`assigned_mechanic_id = auth.uid()`)
   * rejects the NULL transition, which the old open-coded path tried to do via
   * api.updateMaintenanceWorkOrder and triggered a false-positive "reassigned"
   * toast on every legitimate Release click.
   *
   * Intentionally preserves labor_hours / labor_notes / parts_used — the next
   * mechanic inherits the previous diagnostic work.
   */
  releaseMaintenanceWorkOrder: async (id: string, mechanicId: string) => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.rpc("release_maintenance_work_order", {
        p_id: id,
        p_mechanic_id: mechanicId,
      });
      if (error) {
        throw new MaintenanceWorkOrderError(
          "release-failed",
          `releaseMaintenanceWorkOrder: ${reportApiError("RELEASE_MAINTENANCE_WO", error, { id, mechanicId })}`,
        );
      }
      const row = Array.isArray(data) ? data[0] : null;
      if (!row?.ok) {
        // RPC surfaces structured failures (terminal status, row not found,
        // not-your-WO) via ok=false + an `error` string. Re-throw as the
        // typed error with the server message verbatim so the toast says
        // what actually went wrong instead of a generic "could not release".
        throw new MaintenanceWorkOrderError(
          "release-failed",
          row?.error ?? "release_maintenance_work_order returned ok=false",
        );
      }
      // Re-fetch the canonical row so the local mirror matches the DB —
      // a 'queued' row with the assignment cleared. Realtime would reconcile
      // shortly, but waiting for it lets a stale row flash in the queue tab.
      const { data: fresh, error: selErr } = await supabase
        .from("maintenance_work_orders")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (selErr || !fresh) {
        // Release itself succeeded — log and let realtime catch the mirror up.
        void reportApiError("RELEASE_MAINTENANCE_WO_REFETCH", selErr, { id });
        return { ok: true as const };
      }
      getStore().upsertMaintenanceWorkOrder(dbMaintenanceWorkOrderToDomain(fresh));
      return { ok: true as const };
    }
    await wait();
    const store = getStore();
    const existing = store.maintenanceWorkOrders.find((w) => w.id === id);
    if (!existing) {
      throw new MaintenanceWorkOrderError(
        "release-failed",
        `maintenance work order ${id} not found`,
      );
    }
    if (existing.assignedMechanicId !== mechanicId) {
      throw new MaintenanceWorkOrderError("release-failed", "not your work order to release");
    }
    if (existing.status !== "claimed" && existing.status !== "in_progress") {
      throw new MaintenanceWorkOrderError(
        "release-failed",
        `cannot release a work order in status ${existing.status}`,
      );
    }
    const released: MaintenanceWorkOrder = {
      ...existing,
      status: "queued",
      assignedMechanicId: null,
      claimedAt: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
    };
    store.upsertMaintenanceWorkOrder(released);
    return { ok: true as const };
  },

  /**
   * Open a fresh queued maintenance work order — admin path (or driver_note
   * from a driver flagging mid-shift). The inspection-failed trigger inserts
   * its own rows server-side, so callers here only need to cover the manual
   * entry points. idempotency_key support means an offline-queue replay
   * doesn't double-open.
   */
  createMaintenanceWorkOrder: async (input: {
    vehicleId: string;
    issueDescription: string;
    priority?: MaintenanceWorkOrderPriority;
    reportedBy?: string | null;
    reportedFrom?: MaintenanceWorkOrderSource;
    sourceInspectionId?: string | null;
    idempotencyKey?: string;
  }) => {
    const now = new Date().toISOString();
    const wo: MaintenanceWorkOrder = {
      id: uid("MWO"),
      vehicleId: input.vehicleId,
      reportedBy: input.reportedBy ?? null,
      reportedFrom: input.reportedFrom ?? "admin",
      sourceInspectionId: input.sourceInspectionId ?? null,
      issueDescription: input.issueDescription,
      priority: input.priority ?? "medium",
      status: "queued",
      assignedMechanicId: null,
      claimedAt: null,
      startedAt: null,
      completedAt: null,
      partsUsed: [],
      laborHours: 0,
      laborNotes: "",
      finalCost: null,
      completionNotes: null,
      createdAt: now,
      updatedAt: now,
    };
    if (USE_SUPABASE && supabase) {
      try {
        const persisted = await insertWithIdempotency("maintenance_work_orders", {
          id: wo.id,
          vehicle_id: wo.vehicleId,
          reported_by: wo.reportedBy,
          reported_from: wo.reportedFrom,
          source_inspection_id: wo.sourceInspectionId,
          issue_description: wo.issueDescription,
          priority: wo.priority,
          status: wo.status,
          parts_used: [] as unknown as import("./database.types").Json,
          labor_hours: 0,
          labor_notes: "",
          idempotency_key: input.idempotencyKey,
        });
        // Adopt the persisted row (which may differ on idempotency replay).
        const p = persisted as Partial<Row<"maintenance_work_orders">>;
        if (p.id) wo.id = p.id;
        if (p.created_at) wo.createdAt = p.created_at;
        if (p.updated_at) wo.updatedAt = p.updated_at;
      } catch (err) {
        const e = err as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `createMaintenanceWorkOrder: ${reportApiError("CREATE_MAINTENANCE_WO", e, { id: wo.id, vehicleId: wo.vehicleId })}`,
        );
      }
    } else {
      await wait();
    }
    getStore().upsertMaintenanceWorkOrder(wo);
    return wo;
  },

  pushInvoiceToQbo: async (invoiceDataId: string) => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.functions.invoke<{
        qboInvoiceId: string | null;
        qboSyncStatus: QboSyncStatus;
      }>("qbo-push-invoice", { body: { invoiceDataId } });
      if (error)
        throw new Error(
          `pushInvoiceToQbo: ${reportApiError("PUSH_INVOICE_TO_QBO", error, { invoiceDataId })}`,
        );
      return {
        qboInvoiceId: data?.qboInvoiceId ?? null,
        qboSyncStatus: data?.qboSyncStatus ?? "synced",
      };
    }
    await wait();
    return {
      qboInvoiceId: `QBO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      qboSyncStatus: "synced" as QboSyncStatus,
    };
  },

  // ---- QBO payroll mappings (driver -> QBO employee) -------------------
  // Read-only listing used by the admin "QBO mapping" tab in /admin/settings.
  // Pull the active employee list from the connected QuickBooks company so
  // the mapping UI offers a name dropdown instead of hand-typed IDs.
  // Accounting scope — works with the already-authorized connection.
  fetchQboEmployees: async (): Promise<
    { ok: true; employees: Array<{ id: string; name: string }> } | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return {
        ok: true,
        employees: [
          { id: "1", name: "Mock Employee A" },
          { id: "2", name: "Mock Employee B" },
        ],
      };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      employees?: Array<{ id: string; name: string }>;
      error?: string;
    }>("qbo-list-employees", { body: {} });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data?.ok)
      return { ok: false, reason: data?.error ?? "Could not load QuickBooks employees" };
    return { ok: true, employees: data.employees ?? [] };
  },

  // Returns a Record keyed by driverId so the UI can render an input next to
  // each driver row pre-filled with whatever mapping already exists.
  getQboEmployeeMappings: async (): Promise<Record<string, string>> => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase
        .from("qbo_employee_mappings")
        .select("driver_id, qbo_employee_id");
      if (error)
        throw new Error(
          `getQboEmployeeMappings: ${reportApiError("GET_QBO_EMPLOYEE_MAPPINGS", error)}`,
        );
      const out: Record<string, string> = {};
      for (const row of data ?? []) out[row.driver_id] = row.qbo_employee_id;
      return out;
    }
    await wait(50);
    return {};
  },
  // Upsert / delete a single mapping. An empty qboEmployeeId clears the row so
  // an admin can unmap a terminated driver without dropping into SQL.
  upsertQboEmployeeMapping: async (
    driverId: string,
    qboEmployeeId: string,
  ): Promise<{ ok: true }> => {
    const trimmed = qboEmployeeId.trim();
    if (USE_SUPABASE && supabase) {
      if (!trimmed) {
        const { error } = await supabase
          .from("qbo_employee_mappings")
          .delete()
          .eq("driver_id", driverId);
        if (error)
          throw new Error(
            `upsertQboEmployeeMapping.delete: ${reportApiError("UPSERT_QBO_EMPLOYEE_MAPPING", error, { driverId })}`,
          );
        return { ok: true };
      }
      // Best-effort: stamp mapped_by with the calling admin's id so the table
      // doubles as an audit trail.
      let mappedBy: string | null = null;
      try {
        const { data } = await supabase.auth.getUser();
        mappedBy = data.user?.id ?? null;
      } catch {
        mappedBy = null;
      }
      const { error } = await supabase.from("qbo_employee_mappings").upsert(
        {
          driver_id: driverId,
          qbo_employee_id: trimmed,
          mapped_by: mappedBy,
          mapped_at: new Date().toISOString(),
        },
        { onConflict: "driver_id" },
      );
      if (error)
        throw new Error(
          `upsertQboEmployeeMapping: ${reportApiError("UPSERT_QBO_EMPLOYEE_MAPPING", error, { driverId })}`,
        );
    } else {
      await wait(50);
    }
    return { ok: true };
  },

  // Invoke the qbo-push-time edge function to ship completed time entries in
  // [periodStart, periodEnd) as QBO TimeActivity rows. dryRun=true skips the
  // QBO POSTs entirely but still records 'skipped' audit rows so admins can
  // preview what a live run would do.
  pushPayrollToQbo: async (
    periodStart: string,
    periodEnd: string,
    dryRun = false,
  ): Promise<{
    pushed: number;
    failed: number;
    skipped: number;
    totalHours: number;
    durationMs: number;
  }> => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.functions.invoke<{
        pushed: number;
        failed: number;
        skipped: number;
        totalHours: number;
        durationMs: number;
      }>("qbo-push-time", { body: { periodStart, periodEnd, dryRun } });
      if (error)
        throw new Error(
          `pushPayrollToQbo: ${reportApiError("PUSH_PAYROLL_TO_QBO", error, { periodStart, periodEnd, dryRun })}`,
        );
      return {
        pushed: data?.pushed ?? 0,
        failed: data?.failed ?? 0,
        skipped: data?.skipped ?? 0,
        totalHours: data?.totalHours ?? 0,
        durationMs: data?.durationMs ?? 0,
      };
    }
    await wait();
    return { pushed: 0, failed: 0, skipped: 0, totalHours: 0, durationMs: 0 };
  },

  // Invoke the fleetio-import edge function. dryRun=true mirrors the QBO push
  // pattern: same Fleetio fetch + diff so counts are identical, but every
  // upsert is skipped. The edge function writes a single integration_alerts
  // row (kind=fleetio_dryrun_summary) so the preview shows up in the alerts
  // log alongside the QBO dryRun summaries.
  importFromFleetio: async (
    kind: "vehicles" | "maintenance_logs" | "fuel_logs",
    dryRun = false,
  ): Promise<{
    imported: number;
    skipped: number;
    errors: string[];
    importId: string | null;
    durationMs: number;
    dryRun: boolean;
    planned: {
      vehiclesToCreate?: number;
      vehiclesToUpdate?: number;
      maintenanceLogsToImport?: number;
      fuelLogsToImport?: number;
      samples: {
        vehiclesToCreate?: unknown[];
        vehiclesToUpdate?: unknown[];
        maintenanceLogsToImport?: unknown[];
        fuelLogsToImport?: unknown[];
      };
    } | null;
  }> => {
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.functions.invoke<{
        imported: number;
        skipped: number;
        errors: string[];
        importId: string | null;
        durationMs: number;
        dryRun: boolean;
        planned: {
          vehiclesToCreate?: number;
          vehiclesToUpdate?: number;
          maintenanceLogsToImport?: number;
          fuelLogsToImport?: number;
          samples: {
            vehiclesToCreate?: unknown[];
            vehiclesToUpdate?: unknown[];
            maintenanceLogsToImport?: unknown[];
            fuelLogsToImport?: unknown[];
          };
        } | null;
      }>("fleetio-import", { body: { kind, dryRun } });
      if (error)
        throw new Error(
          `importFromFleetio: ${reportApiError("IMPORT_FROM_FLEETIO", error, { kind, dryRun })}`,
        );
      return {
        imported: data?.imported ?? 0,
        skipped: data?.skipped ?? 0,
        errors: data?.errors ?? [],
        importId: data?.importId ?? null,
        durationMs: data?.durationMs ?? 0,
        dryRun: data?.dryRun ?? dryRun,
        planned: data?.planned ?? null,
      };
    }
    await wait();
    return {
      imported: 0,
      skipped: 0,
      errors: [],
      importId: null,
      durationMs: 0,
      dryRun,
      planned: null,
    };
  },

  // ---- Formstack (hauling records / dump forms) ---------------------------
  // Pulls submissions from the Formstack v2025 API into formstack_submissions
  // via the formstack-import edge function. Incremental per form (high-water
  // mark on submitted_at) unless fullResync is set.
  importFromFormstack: async (input: {
    formIds?: number[];
    dryRun?: boolean;
    fullResync?: boolean;
  }): Promise<
    | {
        ok: true;
        dryRun: boolean;
        totalFetched: number;
        totalUpserted: number;
        forms: Array<{
          formId: number;
          formName: string;
          fetched: number;
          upserted: number;
          capped?: boolean;
          error?: string;
        }>;
        // True when the edge function ran out of its time budget before
        // covering every form. Call again with formIds=remainingFormIds to
        // continue — the per-form high-water marks make this idempotent.
        partial: boolean;
        remainingFormIds?: number[];
        durationMs: number;
      }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return {
        ok: true,
        dryRun: input.dryRun ?? false,
        totalFetched: 0,
        totalUpserted: 0,
        forms: [],
        partial: false,
        durationMs: 0,
      };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      dryRun: boolean;
      totalFetched: number;
      totalUpserted: number;
      forms: Array<{
        formId: number;
        formName: string;
        fetched: number;
        upserted: number;
        capped?: boolean;
        error?: string;
      }>;
      partial?: boolean;
      remainingFormIds?: number[];
      error?: string;
      durationMs: number;
    }>("formstack-import", { body: input });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return {
        ok: false,
        reason: reportApiError(
          "IMPORT_FROM_FORMSTACK",
          { message: body ?? error.message },
          { formIds: input.formIds ?? null, dryRun: input.dryRun ?? false },
        ),
      };
    }
    if (!data) return { ok: false, reason: "formstack-import returned no data" };
    if (!data.ok) {
      // Partial failure still carries per-form results — surface the error
      // but keep the successful counts visible to the caller.
      return {
        ok: false,
        reason: data.error ?? "formstack-import reported failure with no error message",
      };
    }
    return {
      ok: true,
      dryRun: data.dryRun,
      totalFetched: data.totalFetched ?? 0,
      totalUpserted: data.totalUpserted ?? 0,
      forms: data.forms ?? [],
      partial: data.partial === true,
      ...(data.remainingFormIds?.length ? { remainingFormIds: data.remainingFormIds } : {}),
      durationMs: data.durationMs ?? 0,
    };
  },

  // Paginated reads for /admin/hauling-records. RLS limits these to admins.
  fetchFormstackSubmissions: async (input: {
    formId?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: FormstackSubmissionRow[]; total: number }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { rows: [], total: 0 };
    }
    const limit = Math.min(input.limit ?? 50, 200);
    const offset = input.offset ?? 0;
    // formstack_submissions isn't in the generated Database types yet — the
    // types snapshot predates the migration. Drop to the untyped client for
    // this table; the explicit casts below pin the row shape. Remove once
    // `supabase gen types` is re-run after the migration applies.
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    let q = untyped
      .from("formstack_submissions")
      .select("id,submission_id,form_id,form_name,submitted_at,summary,data,imported_at", {
        count: "exact",
      })
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (input.formId) q = q.eq("form_id", input.formId);
    if (input.search?.trim()) {
      // Escape PostgREST ilike wildcards in user input.
      const term = input.search.trim().replace(/[%_]/g, "\\$&");
      q = q.or(`summary.ilike.%${term}%,form_name.ilike.%${term}%`);
    }
    const { data, error, count } = await q;
    if (error) {
      throw new Error(
        `fetchFormstackSubmissions: ${reportApiError("FETCH_FORMSTACK_SUBMISSIONS", error, input)}`,
      );
    }
    return {
      rows: (data ?? []).map((r) => ({
        id: r.id as string,
        submissionId: r.submission_id as number,
        formId: r.form_id as number,
        formName: (r.form_name as string) ?? "",
        submittedAt: (r.submitted_at as string | null) ?? null,
        summary: (r.summary as string) ?? "",
        data: (r.data as FormstackSubmissionRow["data"]) ?? [],
        importedAt: (r.imported_at as string) ?? "",
      })),
      total: count ?? 0,
    };
  },

  // ---- Client dump-form portal (Formstack replacement, Phase 1) -----------
  // Public side: the /portal/$code page exchanges the access code for the
  // client's form context, then submits through the same edge function. No
  // user session involved — supabase-js falls back to the anon key and the
  // edge function gates on the code.
  portalContext: async (
    code: string,
  ): Promise<
    | { ok: true; clientName: string; driverNames: string[]; truckNumbers: string[] }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return {
        ok: true,
        clientName: "Mock Client Co.",
        driverNames: ["Mock Driver"],
        truckNumbers: ["TRUCK-1"],
      };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      clientName?: string;
      driverNames?: string[];
      truckNumbers?: string[];
      error?: string;
    }>("client-portal", { body: { action: "context", code } });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data?.ok) return { ok: false, reason: data?.error ?? "Could not load form" };
    return {
      ok: true,
      clientName: data.clientName ?? "",
      driverNames: data.driverNames ?? [],
      truckNumbers: data.truckNumbers ?? [],
    };
  },

  portalSubmitDump: async (
    code: string,
    submission: {
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
    },
  ): Promise<
    { ok: true; submissionCode: string; ticketsRemaining?: number } | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, submissionCode: `MOCK-${Date.now()}` };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      submissionCode?: string;
      ticketsRemaining?: number;
      warnings?: string[];
      error?: string;
    }>("client-portal", { body: { action: "submit", code, submission } });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data?.ok || !data.submissionCode) {
      return { ok: false, reason: data?.error ?? "Submission failed" };
    }
    return {
      ok: true,
      submissionCode: data.submissionCode,
      ...(typeof data.ticketsRemaining === "number"
        ? { ticketsRemaining: data.ticketsRemaining }
        : {}),
    };
  },

  // Admin side: issue/revoke per-employee access codes and manage the
  // per-client dropdown lists. RLS restricts these tables to admins.
  fetchClientPortalTokens: async (
    clientId: string,
  ): Promise<
    Array<{
      id: string;
      code: string;
      label: string;
      createdAt: string;
      revokedAt: string | null;
      lastUsedAt: string | null;
      useCount: number;
    }>
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return [];
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("client_portal_tokens")
      .select("id, code, label, created_at, revoked_at, last_used_at, use_count")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });
    if (error) {
      throw new Error(
        `fetchClientPortalTokens: ${reportApiError("FETCH_PORTAL_TOKENS", error, { clientId })}`,
      );
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      code: r.code as string,
      label: (r.label as string) ?? "",
      createdAt: (r.created_at as string) ?? "",
      revokedAt: (r.revoked_at as string | null) ?? null,
      lastUsedAt: (r.last_used_at as string | null) ?? null,
      useCount: (r.use_count as number) ?? 0,
    }));
  },

  createClientPortalToken: async (input: {
    clientId: string;
    clientName: string;
    label: string;
  }): Promise<{ ok: true; code: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, code: "MOCKCODE-1234" };
    }
    // Code shape: <clientslug>-<6 unambiguous chars>. Generated client-side
    // (admin context) — uniqueness enforced by the DB unique constraint,
    // retried once on the unlikely collision.
    const slug =
      input.clientName
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 12)
        .toUpperCase() || "CLIENT";
    const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
    // The slug is derived from the (publicly known) client name, so it adds no
    // secrecy — ALL of the unguessability lives in the random suffix. Six
    // chars over a 29-symbol alphabet is only ~29 bits, which a determined
    // attacker could brute-force against the un-throttled public client-portal
    // function. Ten chars puts it at ~49 bits, making online enumeration
    // infeasible. Existing 6-char codes keep working (the function accepts
    // 6..80); new codes are stronger. Length stays well under the 80-char cap.
    const SUFFIX_LEN = 10;
    const gen = () => {
      const buf = new Uint8Array(SUFFIX_LEN);
      crypto.getRandomValues(buf);
      return `${slug}-${Array.from(buf, (b) => alphabet[b % alphabet.length]).join("")}`;
    };
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    for (let attempt = 0; attempt < 2; attempt++) {
      const code = gen();
      const { error } = await untyped.from("client_portal_tokens").insert({
        client_id: input.clientId,
        code,
        label: input.label.trim(),
      });
      if (!error) return { ok: true, code };
      if (error.code === "23505") continue;
      return {
        ok: false,
        reason: reportApiError("CREATE_PORTAL_TOKEN", error, { clientId: input.clientId }),
      };
    }
    return { ok: false, reason: "Code collision twice — try again" };
  },

  revokeClientPortalToken: async (
    tokenId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped
      .from("client_portal_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", tokenId);
    if (error) {
      return { ok: false, reason: reportApiError("REVOKE_PORTAL_TOKEN", error, { tokenId }) };
    }
    return { ok: true };
  },

  fetchClientPortalLists: async (
    clientId: string,
  ): Promise<{
    driverNames: string[];
    truckNumbers: string[];
    notifySms: string[];
    notifyEmails: string[];
  }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { driverNames: [], truckNumbers: [], notifySms: [], notifyEmails: [] };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("clients")
      .select("portal_driver_names, portal_truck_numbers, portal_notify_sms, portal_notify_emails")
      .eq("id", clientId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `fetchClientPortalLists: ${reportApiError("FETCH_PORTAL_LISTS", error, { clientId })}`,
      );
    }
    return {
      driverNames: (data?.portal_driver_names as string[]) ?? [],
      truckNumbers: (data?.portal_truck_numbers as string[]) ?? [],
      notifySms: (data?.portal_notify_sms as string[]) ?? [],
      notifyEmails: (data?.portal_notify_emails as string[]) ?? [],
    };
  },

  updateClientPortalLists: async (input: {
    clientId: string;
    driverNames: string[];
    truckNumbers: string[];
    notifySms: string[];
    notifyEmails: string[];
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const clean = (a: string[]) => a.map((s) => s.trim()).filter(Boolean);
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped
      .from("clients")
      .update({
        portal_driver_names: clean(input.driverNames),
        portal_truck_numbers: clean(input.truckNumbers),
        portal_notify_sms: clean(input.notifySms),
        portal_notify_emails: clean(input.notifyEmails),
      })
      .eq("id", input.clientId);
    if (error) {
      return {
        ok: false,
        reason: reportApiError("UPDATE_PORTAL_LISTS", error, { clientId: input.clientId }),
      };
    }
    return { ok: true };
  },

  // ---- Form templates (Phase 4) -------------------------------------------
  fetchFormTemplates: async (opts?: { includeInactive?: boolean }): Promise<FormTemplate[]> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return [];
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    let q = untyped
      .from("form_templates")
      .select("id, name, kind, client_id, fields, active, sort")
      .order("sort", { ascending: true })
      .order("name", { ascending: true });
    if (!opts?.includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) {
      throw new Error(`fetchFormTemplates: ${reportApiError("FETCH_FORM_TEMPLATES", error)}`);
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      name: (r.name as string) ?? "",
      kind: ((r.kind as string) ?? "custom") as FormTemplate["kind"],
      clientId: (r.client_id as string | null) ?? null,
      fields: ((r.fields as FormTemplateField[]) ?? []).filter((f) => f && f.key),
      active: (r.active as boolean) ?? true,
      sort: (r.sort as number) ?? 0,
    }));
  },

  saveFormTemplate: async (
    t: Omit<FormTemplate, "id"> & { id?: string },
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, id: t.id ?? "FT-MOCK" };
    }
    const id = t.id ?? `FT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped.from("form_templates").upsert(
      {
        id,
        name: t.name.trim(),
        kind: t.kind,
        client_id: t.clientId,
        fields: t.fields,
        active: t.active,
        sort: t.sort,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      return { ok: false, reason: reportApiError("SAVE_FORM_TEMPLATE", error, { id }) };
    }
    return { ok: true, id };
  },

  // Photo upload for template forms — path is scoped to the uploader so the
  // storage RLS owner checks line up.
  uploadFormPhoto: async (
    file: File,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, path: `mock/${file.name}` };
    }
    const { data: u } = await supabase.auth.getUser();
    const uid = u?.user?.id ?? "anon";
    const safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_").slice(-60);
    const path = `${uid}/${Date.now()}-${safe}`;
    const { error } = await supabase.storage.from("form-photos").upload(path, file, {
      cacheControl: "3600",
      upsert: false,
    });
    if (error) {
      return { ok: false, reason: reportApiError("UPLOAD_FORM_PHOTO", { message: error.message }) };
    }
    return { ok: true, path };
  },

  getFormPhotoUrl: async (path: string): Promise<string | null> => {
    if (!USE_SUPABASE || !supabase) return null;
    const { data, error } = await supabase.storage.from("form-photos").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  },

  submitCustomForm: async (input: {
    template: FormTemplate;
    data: Record<string, unknown>;
    photos: string[];
    submittedBy: string;
    submittedName: string;
    gpsLat: number | null;
    gpsLng: number | null;
  }): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, id: "FSUB-MOCK" };
    }
    const id = `FSUB-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped.from("form_submissions").insert({
      id,
      template_id: input.template.id,
      template_name: input.template.name,
      template_kind: input.template.kind,
      client_id: input.template.clientId,
      submitted_by: input.submittedBy,
      submitted_name: input.submittedName,
      data: input.data,
      photos: input.photos,
      gps_lat: input.gpsLat,
      gps_lng: input.gpsLng,
      logged_at: new Date().toISOString(),
    });
    if (error) {
      return { ok: false, reason: reportApiError("SUBMIT_CUSTOM_FORM", error, { id }) };
    }
    return { ok: true, id };
  },

  fetchCustomFormSubmissions: async (input: {
    templateId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: CustomFormSubmission[]; total: number }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { rows: [], total: 0 };
    }
    const limit = Math.min(input.limit ?? 50, 200);
    const offset = input.offset ?? 0;
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    let q = untyped
      .from("form_submissions")
      .select(
        "id, template_id, template_name, template_kind, client_id, submitted_by, submitted_name, data, photos, gps_lat, gps_lng, logged_at",
        { count: "exact" },
      )
      .order("logged_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (input.templateId) q = q.eq("template_id", input.templateId);
    if (input.search?.trim()) {
      const term = input.search.trim().replace(/[%_]/g, "\\$&");
      q = q.or(`template_name.ilike.%${term}%,submitted_name.ilike.%${term}%`);
    }
    const { data, error, count } = await q;
    if (error) {
      throw new Error(
        `fetchCustomFormSubmissions: ${reportApiError("FETCH_CUSTOM_FORMS", error, input)}`,
      );
    }
    return {
      rows: (data ?? []).map((r) => ({
        id: r.id as string,
        templateId: (r.template_id as string | null) ?? null,
        templateName: (r.template_name as string) ?? "",
        templateKind: (r.template_kind as string) ?? "custom",
        clientId: (r.client_id as string | null) ?? null,
        submittedBy: (r.submitted_by as string | null) ?? null,
        submittedName: (r.submitted_name as string) ?? "",
        data: (r.data as Record<string, unknown>) ?? {},
        photos: (r.photos as string[]) ?? [],
        gpsLat: (r.gps_lat as number | null) ?? null,
        gpsLng: (r.gps_lng as number | null) ?? null,
        loggedAt: (r.logged_at as string) ?? "",
      })),
      total: count ?? 0,
    };
  },

  fetchFormstackFormFacets: async (): Promise<
    Array<{
      formId: number;
      formName: string;
      submissionCount: number;
      latestSubmittedAt: string | null;
    }>
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return [];
    }
    // Same generated-types caveat as fetchFormstackSubmissions above.
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("formstack_form_facets")
      .select("form_id,form_name,submission_count,latest_submitted_at")
      .order("submission_count", { ascending: false });
    if (error) {
      throw new Error(
        `fetchFormstackFormFacets: ${reportApiError("FETCH_FORMSTACK_FACETS", error)}`,
      );
    }
    return (data ?? []).map((r) => ({
      formId: r.form_id as number,
      formName: (r.form_name as string) ?? "",
      submissionCount: (r.submission_count as number) ?? 0,
      latestSubmittedAt: (r.latest_submitted_at as string | null) ?? null,
    }));
  },

  // Tokens
  generateDriverToken: async (driverId: string, scope: TokenScope, expiresInHours?: number) => {
    const hours = expiresInHours ?? 12;
    if (USE_SUPABASE && supabase) {
      // CSPRNG token minting + driver_tokens insert delegated to the
      // SECURITY DEFINER create_driver_token RPC. Replaces the unsafe
      // Math.random()-based path and guarantees the row lands in the DB
      // (the previous mock-only path would happily mint a token that
      // never existed server-side).
      const { data, error } = await supabase.rpc("create_driver_token", {
        p_driver_id: driverId,
        p_scope: scope,
        p_hours: hours,
      });
      if (error)
        throw new Error(
          `generateDriverToken.rpc: ${reportApiError("CREATE_DRIVER_TOKEN_RPC", error, { driverId, scope, hours })}`,
        );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.token || !row?.expires_at) {
        throw new Error(
          `generateDriverToken.rpc: ${reportApiError("CREATE_DRIVER_TOKEN_RPC", { message: "RPC returned no token row" }, { driverId, scope, hours })}`,
        );
      }
      const t: DriverToken = {
        id: row.id ?? uid("TKN"),
        driverId,
        token: row.token,
        scopedTo: scope,
        expiresAt: row.expires_at,
        usedAt: null,
      };
      getStore().generateDriverToken(t);
      return t;
    }
    await wait();
    const t: DriverToken = {
      id: uid("TKN"),
      driverId,
      token: `tok_${Math.random().toString(36).slice(2, 14)}`,
      scopedTo: scope,
      expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
      usedAt: null,
    };
    getStore().generateDriverToken(t);
    return t;
  },
  validateDriverToken: async (token: string) => {
    // Anon-callable via the SECURITY DEFINER validate_driver_token RPC. A
    // plain SELECT on driver_tokens would hit RLS (admin / driver_id =
    // auth.uid()) and return null for every anon caller on the /t/<token>
    // landing page — i.e. EVERY driver would see "Link invalid" in
    // production. The RPC bypasses RLS just for read-only validation and
    // returns the minimal fields the landing page needs.
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.rpc("validate_driver_token", {
        p_token: token,
      });
      if (error) {
        void reportApiError("VALIDATE_DRIVER_TOKEN", error, { token });
        return { valid: false, token: null as DriverToken | null };
      }
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || row.state === "unknown" || !row.driver_id) {
        return { valid: false, token: null as DriverToken | null };
      }
      const domain: DriverToken = {
        // The RPC doesn't expose the row's own id (we don't need it for the
        // landing page, and surfacing it would couple anon clients to
        // internal pk).
        id: token,
        driverId: row.driver_id,
        token,
        scopedTo: row.scoped_to,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
      };
      return { valid: row.state === "valid", token: domain };
    }
    await wait(100);
    const found = getStore().driverTokens.find((t) => t.token === token);
    const expired = found ? new Date(found.expiresAt).getTime() < Date.now() : true;
    return { valid: !!found && !found.usedAt && !expired, token: found ?? null };
  },
  /**
   * Server-authoritative single-use claim for a driver token. When Supabase is
   * wired up this is the ONLY thing that should be trusted to flip a token to
   * "used" — the SQL RPC performs an atomic update gated on `used_at IS NULL`
   * so concurrent calls from a re-shared link lose the race and return false.
   *
   * On success we mirror the consume into the local store so the admin token
   * table reflects the change immediately. On mock mode we still flip the
   * local store so the existing /admin/settings tests stay green.
   *
   * Returns true when this caller is the one that burned the token; false
   * when the token was missing, expired, already consumed, or a concurrent
   * caller won the race.
   */
  consumeDriverToken: async (token: string): Promise<boolean> => {
    if (!token) return false;
    if (USE_SUPABASE && supabase) {
      const { data, error } = await supabase.rpc("consume_driver_token", { p_token: token });
      if (error) {
        void reportApiError("CONSUME_DRIVER_TOKEN", error, { token });
        return false;
      }
      const ok = data === true;
      if (ok) {
        // Mirror to the local store so the admin tokens table updates without
        // waiting for a refetch. We look the row up by token (not id) since
        // the caller only has the raw token string.
        const store = getStore();
        const row = store.driverTokens.find((t) => t.token === token);
        if (row) store.markTokenUsed(row.id);
      }
      return ok;
    }
    // Mock mode: replicate the server semantics locally so the UI still
    // demonstrates single-use behaviour during demos / local dev.
    await wait(80);
    const store = getStore();
    const row = store.driverTokens.find((t) => t.token === token);
    if (!row) return false;
    if (row.usedAt) return false;
    if (new Date(row.expiresAt).getTime() < Date.now()) return false;
    store.markTokenUsed(row.id);
    return true;
  },

  // ---- App settings (singleton) -----------------------------------------
  fetchAppSettings: async (): Promise<AppSettings> => {
    if (USE_SUPABASE && supabase) {
      try {
        return await fetchAppSettingsFromDb();
      } catch {
        return DEFAULT_APP_SETTINGS;
      }
    }
    await wait(50);
    return DEFAULT_APP_SETTINGS;
  },
  updateAppSettings: async (patch: Partial<AppSettings>): Promise<AppSettings> => {
    const current = getStore().appSettings ?? DEFAULT_APP_SETTINGS;
    const next: AppSettings = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("app_settings")
        .update({
          gps_tolerance_minutes: next.gpsToleranceMinutes,
          overtime_warning_hours: next.overtimeWarningHours,
          overtime_alert_hours: next.overtimeAlertHours,
          inspection_min_duration_seconds: next.inspectionMinDurationSeconds,
          inspection_max_duration_seconds: next.inspectionMaxDurationSeconds,
          business_name: next.businessName,
          tax_id: next.taxId,
          address: next.address,
          timezone: next.timezone,
          currency: next.currency,
          notification_preferences:
            next.notificationPreferences as unknown as import("./database.types").Json,
          updated_at: next.updatedAt,
        })
        .eq("id", "default");
      if (error)
        throw new Error(
          `updateAppSettings: ${reportApiError("UPDATE_APP_SETTINGS", error, { patch })}`,
        );
    } else {
      await wait();
    }
    getStore().setAppSettings(next);
    return next;
  },

  // ---- Billing -----------------------------------------------------------
  // Admin-only: flips billing_status to 'cancel-requested' via the SECDEF
  // RPC and lets the local store mirror the new status. The RPC also drops
  // a notification on every admin profile (handled server-side).
  requestCancelSubscription: async (
    reason: string,
  ): Promise<{ ok: true; status: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      // Mock mode: optimistic local update only.
      return { ok: true, status: "cancel-requested" };
    }
    const { data, error } = await supabase.rpc("request_cancel_subscription", {
      p_reason: reason,
    });
    if (error) {
      reportApiError("REQUEST_CANCEL_SUBSCRIPTION", error, { reason });
      return { ok: false, reason: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      return { ok: false, reason: row?.error ?? "Cancellation failed" };
    }
    return { ok: true, status: row.status };
  },

  // Admin-only: self-service "ask for more vehicles" ping — never a hard cap.
  // Stamps a timestamp+note via the SECDEF RPC and notifies every admin
  // profile (handled server-side). vehiclesLimit is never enforced as a
  // technical block on creating a vehicle.
  requestMoreVehicleCapacity: async (
    requestedCount: number,
    note: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const requestedAt = new Date().toISOString();
    const trimmedNote = note.trim() || null;
    if (!USE_SUPABASE || !supabase) {
      const current = getStore().appSettings;
      getStore().setAppSettings({
        ...current,
        billing: {
          ...current.billing,
          vehicleCapacityRequestedAt: requestedAt,
          vehicleCapacityRequestNote: trimmedNote,
        },
      });
      return { ok: true };
    }
    const { data, error } = await supabase.rpc("request_more_vehicle_capacity", {
      p_requested_count: requestedCount,
      p_note: note,
    });
    if (error) {
      reportApiError("REQUEST_MORE_VEHICLE_CAPACITY", error, { requestedCount, note });
      return { ok: false, reason: error.message };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      return { ok: false, reason: row?.error ?? "Request failed" };
    }
    const current = getStore().appSettings;
    getStore().setAppSettings({
      ...current,
      billing: {
        ...current.billing,
        vehicleCapacityRequestedAt: requestedAt,
        vehicleCapacityRequestNote: trimmedNote,
      },
    });
    return { ok: true };
  },

  // ---- Per-user notification preferences --------------------------------
  // Reads the auth.uid()'s profile.notification_preferences. Returns the
  // safe default in mock mode or if Supabase is unreachable.
  getMyNotificationPreferences: async (): Promise<
    import("@/types/domain").UserNotificationPreferences
  > => {
    const { DEFAULT_USER_NOTIFICATION_PREFERENCES } = await import("@/types/domain");
    if (!USE_SUPABASE || !supabase) return DEFAULT_USER_NOTIFICATION_PREFERENCES;
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData.user?.id;
    if (!uid) return DEFAULT_USER_NOTIFICATION_PREFERENCES;
    const { data, error } = await supabase
      .from("profiles")
      .select("notification_preferences")
      .eq("id", uid)
      .maybeSingle();
    if (error || !data) return DEFAULT_USER_NOTIFICATION_PREFERENCES;
    return {
      ...DEFAULT_USER_NOTIFICATION_PREFERENCES,
      ...((data as { notification_preferences?: object }).notification_preferences ?? {}),
    };
  },

  updateMyNotificationPreferences: async (
    prefs: import("@/types/domain").UserNotificationPreferences,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData.user?.id;
    if (!uid) return { ok: false, reason: "Not signed in" };
    const { error } = await supabase
      .from("profiles")
      .update({
        notification_preferences: prefs as unknown as import("./database.types").Json,
      })
      .eq("id", uid);
    if (error) {
      reportApiError("UPDATE_MY_NOTIF_PREFS", error, { uid });
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  },

  // ---- Notifications: mark-as-read --------------------------------------
  // Flips read_at = now() for every unread notification owned by the given
  // user. Called when the user opens the bell so the badge clears and rows
  // lose their unread treatment. RLS policy `notifications_self_update`
  // already restricts the UPDATE to user_id = auth.uid(); we still narrow
  // by userId client-side so admins reviewing the dropdown don't accidentally
  // clear someone else's row when their session is open. Idempotent — only
  // touches rows where read_at IS NULL.
  markAllNotificationsRead: async (userId: string): Promise<{ ok: true; readAt: string }> => {
    const readAt = new Date().toISOString();
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: readAt })
        .eq("user_id", userId)
        .is("read_at", null);
      if (error)
        throw new Error(
          `markAllNotificationsRead: ${reportApiError("MARK_NOTIFICATIONS_READ", error, { userId })}`,
        );
    } else {
      await wait(50);
    }
    getStore().markAllNotificationsRead(userId, readAt);
    return { ok: true as const, readAt };
  },

  // ---- Support tickets ---------------------------------------------------
  // Driver/mechanic side of /driver/profile → Help & support row. Creates a
  // row in support_tickets that admin can triage. user_id = auth.uid()
  // enforced by RLS WITH CHECK; we still pass it explicitly for clarity.
  createSupportTicket: async (input: {
    subject: string;
    body: string;
  }): Promise<{ ok: true; ticketId: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, ticketId: uid("ST") };
    }
    const { data: authData } = await supabase.auth.getUser();
    const u = authData.user;
    if (!u) return { ok: false, reason: "Not signed in" };
    const ticketId = uid("ST");
    const { error } = await supabase.from("support_tickets").insert({
      id: ticketId,
      user_id: u.id,
      user_email: u.email ?? "",
      subject: input.subject,
      body: input.body,
    });
    if (error) {
      reportApiError("CREATE_SUPPORT_TICKET", error, { subject: input.subject });
      return { ok: false, reason: error.message };
    }
    return { ok: true, ticketId };
  },

  // ---- Email (Resend via send-email edge function) -----------------------
  // Generic transactional email send. Currently used by the invite-user flow
  // (admin-create-user fans this out when sendInviteEmail=true) and intended
  // as the single send-path for any future server-initiated email (critical
  // notification alerts, scheduled reports, etc.).
  //
  // The actual delivery happens server-side so the Resend API key never
  // touches the browser. Failures return a structured reason so toasts can
  // surface "domain not verified" / "API key missing" without exposing the
  // raw Resend error to non-admin users.
  sendEmail: async (input: {
    to: string | string[];
    subject: string;
    html?: string;
    text?: string;
    from?: string;
    replyTo?: string;
    cc?: string | string[];
    bcc?: string | string[];
  }): Promise<{ ok: true; id: string | null } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, id: `MOCK-${Math.random().toString(36).slice(2, 10)}` };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean;
      id?: string | null;
      error?: string;
      provider?: string;
      status?: number;
      errorName?: string | null;
    }>("send-email", { body: input });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data) return { ok: false, reason: "send-email returned no data" };
    if (data.ok !== true) {
      return {
        ok: false,
        reason: data.error ?? "send-email returned ok=false with no error",
      };
    }
    return { ok: true, id: data.id ?? null };
  },

  // ---- Parts inventory (admin Inventory page + mechanic Adjust) -----------
  // The list itself hydrates through DataContext; these are the write paths.
  // Callers pass the result to applyInventoryItem() so the context stays in
  // step without a refetch.
  updateInventoryItem: async (
    id: string,
    patch: {
      name?: string;
      qtyOnHand?: number;
      reorderPoint?: number;
      supplierId?: string;
      location?: string;
      category?: string;
      manufacturer?: string;
      manufacturerPartNumber?: string;
      alternativePartNumber?: string;
      alternativeSupplierId?: string;
      /** Vehicle assignment. Pass null to clear (move to spare pool). */
      assignedVehicleId?: string | null;
      /** Person assignment. Pass null to clear. Mutually exclusive with
       *  assignedVehicleId — the DB CHECK constraint enforces this, so
       *  assigning to a person should always clear the vehicle side (and
       *  vice versa) from the caller, not rely on the constraint to reject
       *  a bad combination after the fact. */
      assignedUserId?: string | null;
      /** Soft-hide (see 20260717170000_archived_parts.sql) — never a delete. */
      archived?: boolean;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      // Mock mode has no DB trigger to fan this out, so mirror
      // trg_inventory_items_notify_low_stock locally. Read the CURRENT store
      // state before the caller's applyInventoryItem() overwrites it — that's
      // the "before" snapshot the crossed-threshold check needs.
      const before = getStore().inventoryItems.find((i) => i.id === id);
      if (before) {
        maybeNotifyLowStockMock(
          getStore(),
          before,
          patch.qtyOnHand ?? before.qtyOnHand,
          patch.reorderPoint ?? before.reorderPoint,
        );
      }
      return { ok: true };
    }
    const dbPatch: Record<string, unknown> = {};
    if (patch.name !== undefined) dbPatch.name = patch.name.trim();
    if (patch.qtyOnHand !== undefined)
      dbPatch.qty_on_hand = Math.max(0, Math.round(patch.qtyOnHand));
    if (patch.reorderPoint !== undefined)
      dbPatch.reorder_point = Math.max(0, Math.round(patch.reorderPoint));
    if (patch.qtyOnHand !== undefined)
      dbPatch.last_restocked = new Date().toISOString().slice(0, 10);
    if (patch.supplierId !== undefined) dbPatch.supplier_id = patch.supplierId.trim() || null;
    if (patch.location !== undefined) dbPatch.location = patch.location.trim();
    if (patch.category !== undefined) dbPatch.category = patch.category.trim();
    if (patch.manufacturer !== undefined) dbPatch.manufacturer = patch.manufacturer.trim();
    if (patch.manufacturerPartNumber !== undefined)
      dbPatch.manufacturer_part_number = patch.manufacturerPartNumber.trim();
    if (patch.alternativePartNumber !== undefined)
      dbPatch.alternative_part_number = patch.alternativePartNumber.trim();
    if (patch.alternativeSupplierId !== undefined)
      dbPatch.alternative_supplier_id = patch.alternativeSupplierId.trim() || null;
    if (patch.assignedVehicleId !== undefined)
      dbPatch.assigned_vehicle_id = patch.assignedVehicleId;
    if (patch.assignedUserId !== undefined) dbPatch.assigned_user_id = patch.assignedUserId;
    if (patch.archived !== undefined) dbPatch.archived = patch.archived;
    const { error } = await supabase
      .from("inventory_items")
      .update(dbPatch as never)
      .eq("id", id);
    if (error) {
      return { ok: false, reason: reportApiError("UPDATE_INVENTORY_ITEM", error, { id }) };
    }
    return { ok: true };
  },

  createInventoryItem: async (input: {
    name: string;
    sku: string;
    qtyOnHand: number;
    reorderPoint: number;
    supplierId?: string;
    location?: string;
    category?: string;
    manufacturer?: string;
    manufacturerPartNumber?: string;
    alternativePartNumber?: string;
    alternativeSupplierId?: string;
  }): Promise<{ ok: true; id: string } | { ok: false; reason: string }> => {
    const id = uid("INV");
    if (!USE_SUPABASE || !supabase) {
      await wait();
      // A new part created already at/below its reorder point (e.g. logging
      // a part that's already out of stock) is just as "low" as one that
      // dropped there — same mirror as updateInventoryItem's mock branch.
      if (input.qtyOnHand <= input.reorderPoint) {
        notifyAllAdminsMock(
          getStore(),
          "alert",
          `Low stock: ${input.name.trim()} (${input.sku.trim()}) — ${input.qtyOnHand} on hand, reorder point ${input.reorderPoint}.`,
          "/admin/inventory",
        );
      }
      return { ok: true, id };
    }
    const { error } = await supabase.from("inventory_items").insert({
      id,
      name: input.name.trim(),
      sku: input.sku.trim(),
      qty_on_hand: Math.max(0, Math.round(input.qtyOnHand)),
      qty_reserved: 0,
      reorder_point: Math.max(0, Math.round(input.reorderPoint)),
      last_restocked: new Date().toISOString().slice(0, 10),
      supplier_id: input.supplierId?.trim() || null,
      location: input.location?.trim() ?? "",
      category: input.category?.trim() ?? "",
      manufacturer: input.manufacturer?.trim() ?? "",
      manufacturer_part_number: input.manufacturerPartNumber?.trim() ?? "",
      alternative_part_number: input.alternativePartNumber?.trim() ?? "",
      alternative_supplier_id: input.alternativeSupplierId?.trim() || null,
    } as never);
    if (error) {
      const reason =
        error.code === "23505"
          ? `SKU "${input.sku.trim()}" already exists`
          : reportApiError("CREATE_INVENTORY_ITEM", error, { sku: input.sku });
      return { ok: false, reason };
    }
    return { ok: true, id };
  },

  // Mints a fresh signed URL for a part-photos storage path. Mirrors
  // signTicketPhotoUrl — the DB column stores a PATH, not a baked URL, so a
  // signed link never sits around long enough to 403 mid-session.
  signInventoryPhotoUrl: async (path: string, ttlSeconds = 3600): Promise<string | null> => {
    if (!USE_SUPABASE || !supabase) return null;
    if (path.startsWith("data:") || path.startsWith("http")) return path;
    const { data, error } = await supabase.storage
      .from("part-photos")
      .createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) {
      console.warn("signInventoryPhotoUrl failed:", error?.message);
      return null;
    }
    return data.signedUrl;
  },

  /**
   * Upload a part photo (data URL from a file input) to the `part-photos`
   * bucket under <itemId>/<random>.jpg and persist the storage path onto
   * inventory_items.photo_url. Mock mode just echoes the data URL back —
   * same convention as uploadTicketPhoto.
   */
  uploadInventoryPhoto: async (input: {
    itemId: string;
    dataUrl: string;
  }): Promise<{ ok: true; photoUrl: string } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, photoUrl: input.dataUrl };
    }
    const blob = await fetch(input.dataUrl).then((r) => r.blob());
    const suffix = crypto.randomUUID().slice(0, 8);
    const path = `${input.itemId}/${suffix}.jpg`;
    const { error: upErr } = await supabase.storage
      .from("part-photos")
      .upload(path, blob, { contentType: "image/jpeg" });
    if (upErr) {
      return {
        ok: false,
        reason: reportApiError("UPLOAD_INVENTORY_PHOTO_STORAGE", upErr, { itemId: input.itemId }),
      };
    }
    const { error: updErr } = await supabase
      .from("inventory_items")
      .update({ photo_url: path } as never)
      .eq("id", input.itemId);
    if (updErr) {
      return {
        ok: false,
        reason: reportApiError("UPLOAD_INVENTORY_PHOTO_UPDATE", updErr, { itemId: input.itemId }),
      };
    }
    return { ok: true, photoUrl: path };
  },

  // ---- Core returns / surcharge credit audit trail -------------------------
  // Client feedback: "A customer returns a pump. It has a core value. The
  // pump is returned to the supplier. The supplier issues a credit. I need
  // the system to track every stage automatically until the credit is
  // received and applied." Three-stage lifecycle (received ->
  // returned_to_supplier -> credited) on public.core_returns — see
  // 20260717190000_core_returns.sql. Deliberately never touches
  // inventory_items.qty_on_hand; this is a financial/paper trail, not a
  // stock movement.
  createCoreReturn: async (input: {
    partDescription: string;
    inventoryItemId: string | null;
    coreValue: number;
    customerName: string;
    receivedAt: string;
    supplierId: string | null;
    notes: string;
  }): Promise<CoreReturn> => {
    const actorId = await currentActorId();
    const r: CoreReturn = {
      id: uid("CR"),
      partDescription: input.partDescription,
      inventoryItemId: input.inventoryItemId,
      coreValue: input.coreValue,
      customerName: input.customerName,
      status: "received",
      receivedAt: input.receivedAt,
      supplierId: input.supplierId,
      rtsReference: "",
      rtsAt: null,
      creditAmount: null,
      creditedAt: null,
      notes: input.notes,
      createdBy: actorId,
      createdAt: new Date().toISOString(),
    };
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.from("core_returns").insert(domainCoreReturnToDb(r));
      if (error)
        throw new Error(
          `createCoreReturn: ${reportApiError("CREATE_CORE_RETURN", error, { id: r.id })}`,
        );
    } else {
      await wait();
    }
    // Unlike submitStartOfDay/uploadTicketPhoto, this does NOT mirror into
    // the store itself — CoreReturnsPanel's onSaved already calls
    // addCoreReturn with the returned row. Doing both would double-insert.
    return r;
  },

  /**
   * Advance a core return to its next stage, or edit an in-flight one.
   * Simple direct UPDATE (no RPC) — unlike the WO-completion / PR-approval
   * flows, nothing here touches stock or races against another actor, so
   * there's no atomicity concern to guard against.
   */
  updateCoreReturn: async (
    id: string,
    patch: {
      status?: CoreReturn["status"];
      supplierId?: string | null;
      rtsReference?: string;
      rtsAt?: string | null;
      creditAmount?: number | null;
      creditedAt?: string | null;
      notes?: string;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (USE_SUPABASE && supabase) {
      const dbPatch: Record<string, unknown> = {};
      if (patch.status !== undefined) dbPatch.status = patch.status;
      if (patch.supplierId !== undefined) dbPatch.supplier_id = patch.supplierId;
      if (patch.rtsReference !== undefined) dbPatch.rts_reference = patch.rtsReference;
      if (patch.rtsAt !== undefined) dbPatch.rts_at = patch.rtsAt;
      if (patch.creditAmount !== undefined) dbPatch.credit_amount = patch.creditAmount;
      if (patch.creditedAt !== undefined) dbPatch.credited_at = patch.creditedAt;
      if (patch.notes !== undefined) dbPatch.notes = patch.notes;
      const { error } = await supabase
        .from("core_returns")
        .update(dbPatch as never)
        .eq("id", id);
      if (error) {
        return { ok: false, reason: reportApiError("UPDATE_CORE_RETURN", error, { id }) };
      }
    } else {
      await wait();
    }
    // Caller (CoreReturnDetail's onPatched) mirrors this into the store —
    // see the note on createCoreReturn above.
    return { ok: true };
  },

  // ---- Multi-Part / Bill of Materials --------------------------------------
  // Client feedback: "one part number that represents many part numbers...
  // when the part number is allocated the full list of parts are allocated
  // and the stock is automatically adjusted." Wholesale delete+insert of a
  // BOM part's component list — same pattern as upsertRateTable — via the
  // SECURITY DEFINER set_bom_components RPC so a network blip mid-edit
  // rolls back instead of leaving the recipe half-defined. Stock
  // consumption itself happens inside complete_maintenance_work_order (see
  // 20260717200000_bom_multi_part.sql), not here — this only edits the
  // recipe.
  setBomComponents: async (
    parentItemId: string,
    isBom: boolean,
    components: { componentItemId: string; qtyPer: number }[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase.rpc("set_bom_components", {
        p_parent_id: parentItemId,
        p_is_bom: isBom,
        p_components: components as unknown as import("./database.types").Json,
      });
      if (error) {
        return {
          ok: false,
          reason: reportApiError("SET_BOM_COMPONENTS", error, { parentItemId }),
        };
      }
    } else {
      await wait();
    }
    const domainComponents: BomComponent[] = components.map((c) => ({
      id: uid("BOM"),
      parentItemId,
      componentItemId: c.componentItemId,
      qtyPer: c.qtyPer,
    }));
    getStore().replaceBomComponents(parentItemId, isBom, isBom ? domainComponents : []);
    return { ok: true };
  },

  // ---- Standalone invoicing (QuickBooks-optional operation) ---------------
  // Email the invoice straight to the client from the CRM and track
  // sent/paid state locally — QuickBooks push stays available but optional.
  fetchInvoiceMeta: async (
    invoiceId: string,
  ): Promise<{ sentAt: string | null; sentTo: string | null; paidAt: string | null }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { sentAt: null, sentTo: null, paidAt: null };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("invoice_data")
      .select("sent_at, sent_to, paid_at")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error) {
      throw new Error(`fetchInvoiceMeta: ${reportApiError("FETCH_INVOICE_META", error)}`);
    }
    return {
      sentAt: (data?.sent_at as string | null) ?? null,
      sentTo: (data?.sent_to as string | null) ?? null,
      paidAt: (data?.paid_at as string | null) ?? null,
    };
  },

  emailInvoice: async (input: {
    invoiceId: string;
    to: string;
    clientName: string;
    billingAddress: string;
    workOrderId: string;
    lineItems: Array<{ description: string; qty: number; rate: number; amount: number }>;
    total: number;
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const esc = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const rows = input.lineItems
      .map(
        (li) =>
          `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">${esc(li.description)}</td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${li.qty}</td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">$${li.rate.toFixed(2)}</td>` +
          `<td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">$${li.amount.toFixed(2)}</td></tr>`,
      )
      .join("");
    const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px;">
<h1 style="font-size:20px;margin:0 0 4px 0;border-bottom:2px solid #D7261E;padding-bottom:8px;">Invoice — Engage Hydrovac Services</h1>
<p style="margin:8px 0 16px 0;color:#666;font-size:13px;">Work order ${esc(input.workOrderId)} · ${new Date().toLocaleDateString()}</p>
<p style="margin:0 0 16px 0;"><strong>Bill to:</strong> ${esc(input.clientName)}<br/>${esc(input.billingAddress)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px;">
<tr style="text-align:left;color:#666;font-size:12px;"><th style="padding:6px 8px;">Description</th><th style="padding:6px 8px;text-align:right;">Qty</th><th style="padding:6px 8px;text-align:right;">Rate</th><th style="padding:6px 8px;text-align:right;">Amount</th></tr>
${rows}
<tr><td colspan="3" style="padding:10px 8px;text-align:right;font-weight:700;">Total</td><td style="padding:10px 8px;text-align:right;font-weight:700;">$${input.total.toFixed(2)}</td></tr>
</table>
<p style="margin:24px 0 0 0;font-size:12px;color:#888;">Questions? Reply to this email. — Engage Hydrovac Services</p>
</body></html>`;
    const text =
      `Invoice — Engage Hydrovac Services\nWork order ${input.workOrderId}\nBill to: ${input.clientName}\n\n` +
      input.lineItems
        .map(
          (li) =>
            `${li.description} | ${li.qty} x $${li.rate.toFixed(2)} = $${li.amount.toFixed(2)}`,
        )
        .join("\n") +
      `\n\nTotal: $${input.total.toFixed(2)}`;
    const sent = await api.sendEmail({
      to: input.to,
      subject: `Invoice from Engage Hydrovac Services — ${input.workOrderId} ($${input.total.toFixed(2)})`,
      html,
      text,
    });
    if (!sent.ok) return { ok: false, reason: sent.reason };
    if (USE_SUPABASE && supabase) {
      const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
      await untyped
        .from("invoice_data")
        .update({ sent_at: new Date().toISOString(), sent_to: input.to })
        .eq("id", input.invoiceId);
    }
    return { ok: true };
  },

  markInvoicePaid: async (
    invoiceId: string,
    paid: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped
      .from("invoice_data")
      .update({ paid_at: paid ? new Date().toISOString() : null })
      .eq("id", invoiceId);
    if (error) {
      return { ok: false, reason: reportApiError("MARK_INVOICE_PAID", error, { invoiceId }) };
    }
    return { ok: true };
  },

  // ---- Payroll rates + receivables ledger (QuickBooks-optional ops) -------
  fetchDriverRates: async (): Promise<Map<string, number>> => {
    const m = new Map<string, number>();
    if (!USE_SUPABASE || !supabase) return m;
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped.from("drivers").select("id, hourly_rate");
    if (error) {
      reportApiError("FETCH_DRIVER_RATES", error);
      return m;
    }
    for (const r of data ?? []) m.set(r.id as string, Number(r.hourly_rate) || 0);
    return m;
  },

  updateDriverRate: async (
    driverId: string,
    hourlyRate: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { error } = await untyped
      .from("drivers")
      .update({ hourly_rate: Math.max(0, hourlyRate) })
      .eq("id", driverId);
    if (error) {
      return { ok: false, reason: reportApiError("UPDATE_DRIVER_RATE", error, { driverId }) };
    }
    return { ok: true };
  },

  // Receivables ledger: every invoice with its sent/paid state, straight
  // from invoice_data (DataContext predates the sent/paid columns).
  fetchInvoiceLedger: async (): Promise<
    Array<{
      id: string;
      workOrderId: string;
      clientId: string;
      kind: string;
      total: number;
      sentAt: string | null;
      sentTo: string | null;
      paidAt: string | null;
      qboSyncStatus: string;
    }>
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return [];
    }
    const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
    const { data, error } = await untyped
      .from("invoice_data")
      .select(
        "id, work_order_id, client_id, kind, total, sent_at, sent_to, paid_at, qbo_sync_status",
      )
      .order("id", { ascending: false })
      .limit(2000);
    if (error) {
      throw new Error(`fetchInvoiceLedger: ${reportApiError("FETCH_INVOICE_LEDGER", error)}`);
    }
    return (data ?? []).map((r) => ({
      id: r.id as string,
      workOrderId: (r.work_order_id as string) ?? "",
      clientId: (r.client_id as string) ?? "",
      kind: (r.kind as string) ?? "work-order",
      total: Number(r.total) || 0,
      sentAt: (r.sent_at as string | null) ?? null,
      sentTo: (r.sent_to as string | null) ?? null,
      paidAt: (r.paid_at as string | null) ?? null,
      qboSyncStatus: (r.qbo_sync_status as string) ?? "not-synced",
    }));
  },

  // ---- Phone-based vehicle tracking (GeoTab replacement) ------------------
  // Driver app pings while a shift is open; the SECURITY DEFINER RPC updates
  // the driver's assigned vehicle so the Live map keeps working without
  // Geotab hardware. Silently no-ops when off-shift or unassigned.
  recordDriverLocation: async (coords: {
    lat: number;
    lng: number;
    speedKmh?: number | null;
  }): Promise<void> => {
    if (!USE_SUPABASE || !supabase) return;
    try {
      // RPC postdates the generated types snapshot — untyped client cast.
      const untyped = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
      await untyped.rpc("record_driver_location", {
        p_lat: coords.lat,
        p_lng: coords.lng,
        p_speed_kmh: coords.speedKmh ?? null,
      });
    } catch {
      /* tracking is best-effort — never surface errors to the driver */
    }
  },

  // ---- User onboarding ---------------------------------------------------
  // Admin-only path for creating a new user (driver/mechanic/admin). Routes
  // through the admin-create-user edge function which uses the service-role
  // key to call auth.admin.createUser — the only way to mint an auth.users
  // row with a known email + role without going through the public signup
  // flow (which is hardened to never grant 'admin' to self-signups). The
  // function also patches profiles.phone and inserts the role-specific side
  // row (drivers). Returns a one-time temporary password the admin hands to
  // the new user; they should immediately rotate via /login → Forgot.
  createUser: async (input: {
    email: string;
    name: string;
    phone?: string;
    role: "admin" | "driver" | "mechanic";
    licenseNumber?: string;
    licenseExpiry?: string;
    // When true, the edge function generates a Supabase recovery link and
    // emails it via Resend. The response carries inviteSent=true and OMITS
    // tempPassword. When false (default), the existing temp-password flow
    // returns the password for the admin to relay manually.
    sendInviteEmail?: boolean;
    // Optional redirect after the recovery link completes. Defaults to
    // SITE_URL/reset-password on the edge function side.
    redirectTo?: string;
    // Owner-only: assign a named custom admin role (tab restrictions) at
    // creation time. Only meaningful when role === "admin".
    adminRoleId?: string;
  }): Promise<
    | { ok: true; userId: string; tempPassword: string; inviteSent: false; reassigned: boolean; warning?: string }
    | { ok: true; userId: string; inviteSent: true; reassigned: boolean; warning?: string }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      if (input.sendInviteEmail) {
        return {
          ok: true,
          userId: `MOCK-${Math.random().toString(36).slice(2, 10)}`,
          inviteSent: true,
          reassigned: false,
        };
      }
      return {
        ok: true,
        userId: `MOCK-${Math.random().toString(36).slice(2, 10)}`,
        tempPassword: "mock-pw-12345",
        inviteSent: false,
        reassigned: false,
      };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      userId?: string;
      tempPassword?: string;
      inviteSent?: boolean;
      reassigned?: boolean;
      warning?: string;
      error?: string;
    }>("admin-create-user", { body: input });
    if (error) {
      // Non-2xx responses carry the real diagnostic in the response body
      // (e.g. "admin role required", "Drivers row insert failed … auth user
      // was rolled back"), not in error.message. Pull it out so the toast
      // is actionable, and report whichever message we ended up with.
      const body = await extractFunctionErrorBody(error);
      return {
        ok: false,
        reason: reportApiError("ADMIN_CREATE_USER", body ? { message: body } : error, {
          email: input.email,
          role: input.role,
        }),
      };
    }
    if (!data || !data.ok || !data.userId) {
      return { ok: false, reason: data?.error ?? "createUser: empty response" };
    }
    if (data.inviteSent === true) {
      return {
        ok: true,
        userId: data.userId,
        inviteSent: true,
        reassigned: data.reassigned === true,
        ...(data.warning ? { warning: data.warning } : {}),
      };
    }
    if (!data.tempPassword) {
      return { ok: false, reason: data.error ?? "createUser: no tempPassword and no invite" };
    }
    return {
      ok: true,
      userId: data.userId,
      tempPassword: data.tempPassword,
      inviteSent: false,
      reassigned: data.reassigned === true,
      ...(data.warning ? { warning: data.warning } : {}),
    };
  },

  // ---- Owner admin access management --------------------------------------
  // Named custom admin roles (per-tab access) + per-user assignment. Reads
  // are available to every admin (each client resolves its own tab set);
  // writes are owner-only — enforced server-side by admin_roles RLS and the
  // profiles access-column guard trigger. These wrappers only surface those
  // errors; they are not the authority.
  listAdminRoles: async (): Promise<
    { ok: true; roles: import("@/types/domain").AdminRole[] } | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, roles: [] };
    }
    const { data, error } = await supabase
      .from("admin_roles")
      .select("id, name, allowed_tabs")
      .order("name");
    if (error) {
      return { ok: false, reason: reportApiError("LIST_ADMIN_ROLES", error) };
    }
    return {
      ok: true,
      roles: (data ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        allowedTabs: r.allowed_tabs ?? [],
      })),
    };
  },

  saveAdminRole: async (input: {
    id?: string;
    name: string;
    allowedTabs: string[];
  }): Promise<
    { ok: true; role: import("@/types/domain").AdminRole } | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return {
        ok: true,
        role: {
          id: input.id ?? `MOCK-ROLE-${Math.random().toString(36).slice(2, 10)}`,
          name: input.name,
          allowedTabs: input.allowedTabs,
        },
      };
    }
    const row = {
      name: input.name.trim(),
      allowed_tabs: input.allowedTabs,
      ...(input.id ? { id: input.id } : {}),
    };
    const { data, error } = await supabase
      .from("admin_roles")
      .upsert(row)
      .select("id, name, allowed_tabs")
      .single();
    if (error) {
      // 23505 = unique_violation on admin_roles.name — friendlier than the
      // raw constraint message and not worth an error_log row.
      if (error.code === "23505") {
        return { ok: false, reason: `A role named "${input.name.trim()}" already exists` };
      }
      return {
        ok: false,
        reason: reportApiError("SAVE_ADMIN_ROLE", error, { name: input.name }),
      };
    }
    return {
      ok: true,
      role: { id: data.id, name: data.name, allowedTabs: data.allowed_tabs ?? [] },
    };
  },

  deleteAdminRole: async (id: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const { error } = await supabase.from("admin_roles").delete().eq("id", id);
    if (error) {
      // 23503 = the on-delete-restrict FK from profiles.admin_role_id — a
      // role in use must be unassigned first (never silently deleted, which
      // would flip its members back to full access).
      if (error.code === "23503") {
        return {
          ok: false,
          reason: "This role is still assigned to one or more users — reassign them first",
        };
      }
      return { ok: false, reason: reportApiError("DELETE_ADMIN_ROLE", error, { id }) };
    }
    return { ok: true };
  },

  // Access settings for every admin profile, keyed by profile id. Used by
  // the owner-only Users & roles UI to render the Access column/editor.
  listAdminAccess: async (): Promise<
    | {
        ok: true;
        access: Record<
          string,
          import("@/types/domain").AdminAccess & { roleName: string | null; active: boolean }
        >;
      }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true, access: {} };
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("id, status, is_owner, admin_role_id, allowed_tabs_override, admin_roles(name)")
      .eq("role", "admin");
    if (error) {
      return { ok: false, reason: reportApiError("LIST_ADMIN_ACCESS", error) };
    }
    const access: Record<
      string,
      import("@/types/domain").AdminAccess & { roleName: string | null; active: boolean }
    > = {};
    for (const p of data ?? []) {
      access[p.id] = {
        isOwner: Boolean(p.is_owner),
        adminRoleId: p.admin_role_id,
        allowedTabsOverride: p.allowed_tabs_override,
        roleName: p.admin_roles?.name ?? null,
        active: p.status === "active",
      };
    }
    return { ok: true, access };
  },

  updateAdminAccess: async (
    userId: string,
    patch: {
      isOwner?: boolean;
      adminRoleId?: string | null;
      allowedTabsOverride?: string[] | null;
    },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const row: {
      is_owner?: boolean;
      admin_role_id?: string | null;
      allowed_tabs_override?: string[] | null;
    } = {};
    if (patch.isOwner !== undefined) row.is_owner = patch.isOwner;
    if (patch.adminRoleId !== undefined) row.admin_role_id = patch.adminRoleId;
    if (patch.allowedTabsOverride !== undefined)
      row.allowed_tabs_override = patch.allowedTabsOverride;
    const { error } = await supabase.from("profiles").update(row).eq("id", userId);
    if (error) {
      // The guard triggers raise insufficient_privilege with human-readable
      // messages ("Cannot remove the last owner admin", "Only an owner admin
      // can change admin access settings") — show them as-is instead of
      // logging an error_log row for an expected authorization denial.
      if (error.code === "42501" || /owner admin/i.test(error.message)) {
        return { ok: false, reason: error.message };
      }
      return { ok: false, reason: reportApiError("UPDATE_ADMIN_ACCESS", error, { userId }) };
    }
    return { ok: true };
  },

  // Mechanic-tier flag (not owner-gated — see the migration comment on
  // profiles.is_workshop_manager — any admin can promote/demote a mechanic).
  setWorkshopManager: async (
    mechanicId: string,
    isWorkshopManager: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const { error } = await supabase
      .from("profiles")
      .update({ is_workshop_manager: isWorkshopManager })
      .eq("id", mechanicId);
    if (error) {
      return { ok: false, reason: reportApiError("SET_WORKSHOP_MANAGER", error, { mechanicId }) };
    }
    return { ok: true };
  },

  // ---- Vehicles ----------------------------------------------------------
  // Admin-only path for adding a vehicle from the /admin/vehicles grid. The
  // Add-vehicle dialog only collects the four required-NOT-NULL columns on
  // public.vehicles (id, name, type, year) plus we synthesise placeholder
  // plate + vin so the NOT NULL constraints don't blow up; admins refine
  // those on the vehicle detail page. Mirrors the createUser shape: mock-mode
  // branch, structured { ok, reason } returns so the dialog can surface the
  // failure inline rather than crashing on a thrown error.
  createVehicle: async (input: {
    id: string;
    name: string;
    type: "truck" | "trailer" | "equipment";
    year: number;
  }): Promise<
    { ok: true; vehicle: import("@/types/domain").Vehicle } | { ok: false; reason: string }
  > => {
    // Build the domain object first so both code paths return the same shape
    // for the local-store upsert at the end.
    const vehicle: import("@/types/domain").Vehicle = {
      id: input.id,
      name: input.name,
      plate: "",
      year: input.year,
      type: input.type,
      vin: "",
      odometer: 0,
      engineHours: 0,
      lastService: "",
      nextServiceDue: "",
      driverId: null,
      geotabDeviceId: null,
      status: "operational",
    };
    if (!USE_SUPABASE || !supabase) {
      await wait();
      getStore().upsertVehicle(vehicle);
      return { ok: true, vehicle };
    }
    const { error } = await supabase.from("vehicles").insert({
      id: vehicle.id,
      name: vehicle.name,
      plate: vehicle.plate,
      year: vehicle.year,
      type: vehicle.type,
      vin: vehicle.vin,
      odometer: vehicle.odometer,
      engine_hours: vehicle.engineHours,
      status: vehicle.status,
      driver_id: vehicle.driverId,
      geotab_device_id: vehicle.geotabDeviceId,
    });
    if (error) {
      return {
        ok: false,
        reason: reportApiError("CREATE_VEHICLE", error, { vehicleId: vehicle.id }),
      };
    }
    getStore().upsertVehicle(vehicle);
    return { ok: true, vehicle };
  },

  // ---- Integrations health probe -----------------------------------------
  // Hits the integrations-probe edge function which runs a live auth-handshake
  // probe against each external integration (Twilio, Geotab, QBO, Fleetio)
  // and returns structured status. Used by /admin/settings → Integrations to
  // render real status badges instead of the hardcoded mock data that used
  // to live in that component.
  //
  // Mock mode (USE_SUPABASE=false): returns a static "probed but not really"
  // payload so the dev experience is still meaningful — the badge subtitle
  // says "Mock mode" and reachable=null so the badge renders gray.
  probeIntegrations: async (): Promise<{
    ok: boolean;
    integrations: Array<{
      name: string;
      desc: string;
      configured: boolean;
      reachable: boolean | null;
      rawProbeMsg: string;
      lastError: string | null;
      checkedAt: string;
    }>;
    checkedAt: string;
  }> => {
    if (!USE_SUPABASE || !supabase) {
      const now = new Date().toISOString();
      const mock = (name: string, desc: string) => ({
        name,
        desc,
        configured: false,
        reachable: null,
        rawProbeMsg: "Mock mode — probe skipped (set VITE_USE_SUPABASE=true)",
        lastError: null,
        checkedAt: now,
      });
      return {
        ok: true,
        checkedAt: now,
        integrations: [
          mock("Twilio", "SMS notifications + driver/mechanic Communications"),
          mock("Geotab", "GPS + telematics + timesheet cross-reference"),
          mock("QuickBooks Online", "Invoice + payroll sync"),
          mock("Fleetio", "One-time vehicle data migration"),
        ],
      };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok: boolean;
      integrations: Array<{
        name: string;
        desc: string;
        configured: boolean;
        reachable: boolean | null;
        rawProbeMsg: string;
        lastError: string | null;
        checkedAt: string;
      }>;
      checkedAt: string;
    }>("integrations-probe", { body: {} });
    if (error || !data) {
      const now = new Date().toISOString();
      const fail = (name: string, desc: string) => ({
        name,
        desc,
        configured: false,
        reachable: false,
        rawProbeMsg: `Probe call failed: ${error?.message ?? "no response"}`,
        lastError: null,
        checkedAt: now,
      });
      return {
        ok: false,
        checkedAt: now,
        integrations: [
          fail("Twilio", "SMS notifications + driver/mechanic Communications"),
          fail("Geotab", "GPS + telematics + timesheet cross-reference"),
          fail("QuickBooks Online", "Invoice + payroll sync"),
          fail("Fleetio", "One-time vehicle data migration"),
        ],
      };
    }
    return data;
  },

  // ---- QBO OAuth onboarding ----------------------------------------------
  // Two-step authorization-code flow:
  //   1. startQboOAuth() asks the qbo-oauth-start edge function for the
  //      Intuit authorize URL + a random `state` token. Caller stashes
  //      state in sessionStorage and window.location.assign(authorizeUrl).
  //   2. After the admin grants access, Intuit redirects to QBO_REDIRECT_URI
  //      (the /admin/settings/qbo-callback route) with ?code, ?realmId, ?state
  //      in the URL. The route calls completeQboOAuth() which hands the code
  //      + state + the sessionStorage value to qbo-oauth-callback, which
  //      exchanges for refresh_token and persists.
  startQboOAuth: async (): Promise<
    | { ok: true; authorizeUrl: string; state: string; redirectUri: string }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      return { ok: false, reason: "Set VITE_USE_SUPABASE=true to run OAuth" };
    }
    const { data, error } = await supabase.functions.invoke<{
      authorizeUrl?: string;
      state?: string;
      redirectUri?: string;
      error?: string;
    }>("qbo-oauth-start", { body: {} });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data) return { ok: false, reason: "Empty response from qbo-oauth-start" };
    if (data.error) return { ok: false, reason: data.error };
    if (!data.authorizeUrl || !data.state || !data.redirectUri) {
      return { ok: false, reason: "Malformed response from qbo-oauth-start" };
    }
    return {
      ok: true,
      authorizeUrl: data.authorizeUrl,
      state: data.state,
      redirectUri: data.redirectUri,
    };
  },
  completeQboOAuth: async (input: {
    code: string;
    realmId: string;
    state: string;
    expectedState: string;
  }): Promise<
    | {
        ok: true;
        realmId: string;
        env: string;
        refreshedSelfTest: boolean;
        selfTestMsg: string | null;
      }
    | { ok: false; reason: string }
  > => {
    if (!USE_SUPABASE || !supabase) {
      return { ok: false, reason: "Set VITE_USE_SUPABASE=true to run OAuth" };
    }
    const { data, error } = await supabase.functions.invoke<{
      ok?: boolean;
      realmId?: string;
      env?: string;
      refreshedSelfTest?: boolean;
      selfTestMsg?: string | null;
      error?: string;
      step?: string;
      intuitError?: string;
      intuitStatus?: number;
      hint?: string;
    }>("qbo-oauth-callback", { body: input });
    if (error) {
      const body = await extractFunctionErrorBody(error);
      return { ok: false, reason: body ?? error.message };
    }
    if (!data) return { ok: false, reason: "Empty response from qbo-oauth-callback" };
    if (data.ok !== true) {
      const parts = [
        data.error ?? "qbo-oauth-callback returned ok=false",
        data.step ? `(step: ${data.step})` : "",
        data.intuitStatus ? `Intuit HTTP ${data.intuitStatus}` : "",
        data.intuitError ? data.intuitError : "",
        data.hint ?? "",
      ].filter(Boolean);
      return { ok: false, reason: parts.join(" — ") };
    }
    return {
      ok: true,
      realmId: data.realmId ?? input.realmId,
      env: data.env ?? "sandbox",
      refreshedSelfTest: data.refreshedSelfTest === true,
      selfTestMsg: data.selfTestMsg ?? null,
    };
  },

  // ---- Profile / user phone management -----------------------------------
  // Admin-only path for updating someone else's profile.phone. Drivers can
  // also update their own (RLS profiles_self_update allows it). Used by the
  // admin/drivers page so admins can set real E.164 phone numbers on drivers
  // and mechanics — required before outbound SMS via Twilio will reach them.
  //
  // E.164 validation happens client-side; we re-validate here as defense in
  // depth and return a structured error rather than throwing for the common
  // "bad format" case.
  updateUserPhone: async (input: {
    userId: string;
    phone: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const trimmed = input.phone.trim();
    if (!/^\+[1-9]\d{9,14}$/.test(trimmed)) {
      return { ok: false, reason: "Phone must be E.164 format (e.g. +14165550100)" };
    }
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return { ok: true };
    }
    const { error } = await supabase
      .from("profiles")
      .update({ phone: trimmed })
      .eq("id", input.userId);
    if (error) {
      reportApiError("UPDATE_USER_PHONE", error, { userId: input.userId });
      return { ok: false, reason: error.message };
    }
    return { ok: true };
  },

  // ---- Communications ----------------------------------------------------
  // All mutations route through SECDEF RPCs so the server enforces role +
  // participant invariants. Local DataContext mirrors via realtime, but
  // these helpers also push the row through getStore() so the UI updates
  // instantly without waiting for the realtime hop.

  openConversation: async (input: {
    topic: import("@/types/domain").ConversationTopic;
    topicRefId: string | null;
    subject: string;
    counterpartyId: string;
  }): Promise<import("@/types/domain").Conversation> => {
    if (!USE_SUPABASE || !supabase) {
      // Mock mode: synthesize a row so the UI renders.
      const conv: import("@/types/domain").Conversation = {
        id: uid("CV"),
        twilioConversationSid: null,
        topic: input.topic,
        topicRefId: input.topicRefId,
        subject: input.subject,
        status: "active",
        createdBy: "mock-user",
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        closedAt: null,
        closedBy: null,
        resolutionNotes: null,
      };
      getStore().upsertConversation(conv);
      return conv;
    }
    // Generated RPC types mark p_topic_ref_id as `string`; coalesce null to ""
    // and let the SQL function's NULLIF(trim(...), '') convert it back to NULL.
    const { data, error } = await supabase.rpc("open_conversation", {
      p_topic: input.topic,
      p_topic_ref_id: input.topicRefId ?? "",
      p_subject: input.subject,
      p_counterparty_id: input.counterpartyId,
    });
    if (error)
      throw new Error(`openConversation: ${reportApiError("OPEN_CONVERSATION", error, input)}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("openConversation: empty response");
    const { dbConversationToDomain } = await import("./db-mappers");
    const conv = dbConversationToDomain(row as Row<"conversations">);
    getStore().upsertConversation(conv);
    return conv;
  },

  openConversationWithParticipants: async (input: {
    topic: import("@/types/domain").ConversationTopic;
    topicRefId: string | null;
    subject: string;
    participantIds: string[];
  }): Promise<import("@/types/domain").Conversation> => {
    if (!USE_SUPABASE || !supabase) {
      const conv: import("@/types/domain").Conversation = {
        id: uid("CV"),
        twilioConversationSid: null,
        topic: input.topic,
        topicRefId: input.topicRefId,
        subject: input.subject,
        status: "active",
        createdBy: "mock-admin",
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        closedAt: null,
        closedBy: null,
        resolutionNotes: null,
      };
      getStore().upsertConversation(conv);
      return conv;
    }
    const { data, error } = await supabase.rpc("open_conversation_with_participants", {
      p_topic: input.topic,
      p_topic_ref_id: input.topicRefId ?? "",
      p_subject: input.subject,
      p_participant_ids: input.participantIds,
    });
    if (error)
      throw new Error(
        `openConversationWithParticipants: ${reportApiError("OPEN_CONVERSATION_WITH_PARTICIPANTS", error, input)}`,
      );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("openConversationWithParticipants: empty response");
    const { dbConversationToDomain } = await import("./db-mappers");
    const conv = dbConversationToDomain(row as Row<"conversations">);
    getStore().upsertConversation(conv);
    return conv;
  },

  // Sends a message into a conversation. Routes through the
  // twilio-send-message edge function, which posts to Twilio Conversations
  // API and mirrors to public.messages. The function handles lazy creation
  // of the Twilio Conversation + per-participant bindings on first send.
  // idempotencyKey makes offline-queue replays safe (server-side unique
  // index on (sender_id, idempotency_key) blocks duplicate inserts).
  //
  // Mock mode (no Supabase env): synthesizes a local row only — no Twilio
  // hop. Useful for dev + E2E that doesn't need real SMS delivery.
  sendMessage: async (input: {
    conversationId: string;
    body: string;
    mediaPaths?: string[];
    idempotencyKey?: string;
  }): Promise<import("@/types/domain").Message> => {
    if (!USE_SUPABASE || !supabase) {
      const msg: import("@/types/domain").Message = {
        id: uid("MSG"),
        conversationId: input.conversationId,
        twilioMessageSid: null,
        idempotencyKey: input.idempotencyKey ?? null,
        senderId: "mock-user",
        senderKind: "in_app",
        body: input.body,
        mediaPaths: input.mediaPaths ?? [],
        twilioMediaUrls: [],
        deliveryStatus: "sent",
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      };
      getStore().upsertMessage(msg);
      return msg;
    }
    // Route through edge function → Twilio → DB. Returns the persisted row.
    const { data, error } = await supabase.functions.invoke<{ message: Row<"messages"> }>(
      "twilio-send-message",
      {
        body: {
          conversationId: input.conversationId,
          body: input.body,
          mediaPaths: input.mediaPaths ?? [],
          idempotencyKey: input.idempotencyKey ?? null,
        },
      },
    );
    if (error) {
      throw new Error(
        `sendMessage: ${reportApiError("SEND_MESSAGE", error, { conversationId: input.conversationId })}`,
      );
    }
    const row = data?.message;
    if (!row) throw new Error("sendMessage: edge function returned no message");
    const { dbMessageToDomain } = await import("./db-mappers");
    const msg = dbMessageToDomain(row);
    getStore().upsertMessage(msg);
    return msg;
  },

  tagAdmins: async (input: {
    conversationId: string;
    adminIds?: string[] | null;
  }): Promise<import("@/types/domain").ConversationParticipant[]> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return [];
    }
    // p_admin_ids is `uuid[] DEFAULT NULL` server-side; the generated type
    // marks it as optional. Pass undefined when null so the default kicks in.
    const { data, error } = await supabase.rpc("tag_admins", {
      p_conversation_id: input.conversationId,
      ...(input.adminIds ? { p_admin_ids: input.adminIds } : {}),
    });
    if (error) throw new Error(`tagAdmins: ${reportApiError("TAG_ADMINS", error, input)}`);
    const rows = (data ?? []) as Row<"conversation_participants">[];
    const { dbConversationParticipantToDomain } = await import("./db-mappers");
    const cps = rows.map(dbConversationParticipantToDomain);
    cps.forEach((cp) => getStore().upsertParticipant(cp));
    return cps;
  },

  joinConversation: async (
    conversationId: string,
  ): Promise<import("@/types/domain").ConversationParticipant> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      const cp: import("@/types/domain").ConversationParticipant = {
        id: uid("CP"),
        conversationId,
        userId: "mock-admin",
        participantRole: "admin",
        twilioParticipantSid: null,
        joinedAt: new Date().toISOString(),
        leftAt: null,
        lastReadAt: null,
      };
      getStore().upsertParticipant(cp);
      return cp;
    }
    const { data, error } = await supabase.rpc("join_conversation", {
      p_conversation_id: conversationId,
    });
    if (error)
      throw new Error(
        `joinConversation: ${reportApiError("JOIN_CONVERSATION", error, { conversationId })}`,
      );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("joinConversation: empty response");
    const { dbConversationParticipantToDomain } = await import("./db-mappers");
    const cp = dbConversationParticipantToDomain(row as Row<"conversation_participants">);
    getStore().upsertParticipant(cp);
    return cp;
  },

  leaveConversation: async (conversationId: string): Promise<void> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      return;
    }
    const { error } = await supabase.rpc("leave_conversation", {
      p_conversation_id: conversationId,
    });
    if (error)
      throw new Error(
        `leaveConversation: ${reportApiError("LEAVE_CONVERSATION", error, { conversationId })}`,
      );
  },

  markConversationRead: async (conversationId: string): Promise<void> => {
    if (!USE_SUPABASE || !supabase) return;
    const { error } = await supabase.rpc("mark_conversation_read", {
      p_conversation_id: conversationId,
    });
    if (error)
      throw new Error(
        `markConversationRead: ${reportApiError("MARK_CONVERSATION_READ", error, { conversationId })}`,
      );
  },

  closeConversation: async (
    conversationId: string,
    resolutionNotes: string,
  ): Promise<import("@/types/domain").Conversation> => {
    if (!USE_SUPABASE || !supabase) {
      await wait();
      const conv = getStore().conversations.find((c) => c.id === conversationId);
      if (!conv) throw new Error("conversation not found in mock store");
      const closed = { ...conv, status: "closed" as const, resolutionNotes };
      getStore().upsertConversation(closed);
      return closed;
    }
    const { data, error } = await supabase.rpc("close_conversation", {
      p_conversation_id: conversationId,
      p_resolution_notes: resolutionNotes,
    });
    if (error)
      throw new Error(
        `closeConversation: ${reportApiError("CLOSE_CONVERSATION", error, { conversationId })}`,
      );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("closeConversation: empty response");
    const { dbConversationToDomain } = await import("./db-mappers");
    const conv = dbConversationToDomain(row as Row<"conversations">);
    getStore().upsertConversation(conv);
    return conv;
  },

  // Uploads a file to the message-attachments Storage bucket and returns the
  // PATH (not a signed URL). The caller persists this path in messages.media_paths;
  // the viewer mints a fresh signed URL on demand. A baked-in long-lived URL
  // would 403 once it expires.
  uploadMessageAttachment: async (input: {
    conversationId: string;
    file: File | Blob;
    fileName: string;
  }): Promise<string> => {
    if (!USE_SUPABASE || !supabase) {
      return `mock://message-attachments/${input.conversationId}/${input.fileName}`;
    }
    const { data: authData } = await supabase.auth.getUser();
    const uploaderId = authData.user?.id ?? "anon";
    const path = `${input.conversationId}/${uploaderId}-${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error } = await supabase.storage.from("message-attachments").upload(path, input.file, {
      contentType: input.file.type || "application/octet-stream",
      upsert: false,
    });
    if (error)
      throw new Error(
        `uploadMessageAttachment: ${reportApiError("UPLOAD_MESSAGE_ATTACHMENT", error, { conversationId: input.conversationId })}`,
      );
    return path;
  },

  // Mints a fresh signed URL for an attachment path. Default 1-hour TTL.
  signMessageAttachment: async (
    path: string,
    ttlSeconds: number = 3600,
  ): Promise<string | null> => {
    if (!USE_SUPABASE || !supabase) return path; // mock path is already a URL-shaped string
    if (path.startsWith("http") || path.startsWith("data:")) return path;
    const { data, error } = await supabase.storage
      .from("message-attachments")
      .createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  },

  // Fetches a window of older messages for a conversation. Used when the
  // user scrolls up past the initial 500-message hydration.
  fetchConversationMessages: async (
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<import("@/types/domain").Message[]> => {
    if (!USE_SUPABASE || !supabase) return [];
    let q = supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 50);
    if (opts.before) q = q.lt("created_at", opts.before);
    const { data, error } = await q;
    if (error)
      throw new Error(
        `fetchConversationMessages: ${reportApiError("FETCH_CONVERSATION_MESSAGES", error, { conversationId })}`,
      );
    const { dbMessageToDomain } = await import("./db-mappers");
    return (data ?? []).map((r) => dbMessageToDomain(r as Row<"messages">));
  },

  // ---- Timesheet flag overrides ----------------------------------------
  // Admin-only: clear or apply a manual flag on a time entry. Persists the
  // flag column so re-flagging due to a tolerance change won't silently
  // overwrite an admin's decision.
  setTimeEntryFlag: async (
    entryId: string,
    flagged: boolean,
    reason: string,
  ): Promise<{ ok: true }> => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("time_entries")
        .update({ flagged, flag_reason: reason })
        .eq("id", entryId);
      if (error)
        throw new Error(
          `setTimeEntryFlag: ${reportApiError("SET_TIME_ENTRY_FLAG", error, { entryId, flagged })}`,
        );
    } else {
      await wait(50);
    }
    getStore().setTimeEntryFlag(entryId, flagged, reason);
    return { ok: true };
  },

  // ---- Prepaid dump tickets ---------------------------------------------
  updateClientTicketSettings: async (clientId: string, patch: Partial<ClientTicketSettings>) => {
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("clients")
        .update({
          ...(patch.enabled !== undefined && { tickets_enabled: patch.enabled }),
          ...(patch.balance !== undefined && { tickets_balance: patch.balance }),
          ...(patch.threshold !== undefined && { tickets_threshold: patch.threshold }),
          ...(patch.bundleSize !== undefined && { tickets_bundle_size: patch.bundleSize }),
          ...(patch.bundlePrice !== undefined && { tickets_bundle_price: patch.bundlePrice }),
          ...(patch.autoBillEnabled !== undefined && {
            tickets_auto_bill_enabled: patch.autoBillEnabled,
          }),
          ...(patch.reportFrequency !== undefined && {
            tickets_report_frequency: patch.reportFrequency,
          }),
          ...(patch.reportRecipients !== undefined && {
            tickets_report_recipients: patch.reportRecipients,
          }),
        })
        .eq("id", clientId);
      if (error)
        throw new Error(
          `updateClientTicketSettings: ${reportApiError("UPDATE_CLIENT_TICKET_SETTINGS", error, { clientId })}`,
        );
    } else {
      await wait();
    }
    getStore().updateClientTicketSettings(clientId, patch);
    return { ok: true };
  },

  topUpTickets: async (clientId: string, qty: number, actorId?: string) => {
    const client = getStore().clients.find((c) => c.id === clientId);
    if (!client) {
      const msg = `client ${clientId} not found`;
      void reportErrorToServer({
        severity: "error",
        errorCode: "TOP_UP_TICKETS",
        message: `top_up_tickets: ${msg}`,
        context: { clientId },
      });
      throw new Error(`topUpTickets: ${msg}`);
    }
    // Guard the bundle size before any math: a blank/zeroed/NaN input (the
    // admin clears the "default bundle size" field) would otherwise build a
    // corrupt invoice line — rate: price / 0 === Infinity, or all-NaN — and
    // poison the client's balance.
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`topUpTickets: bundle size must be a positive number (got ${qty})`);
    }
    const price = client.tickets.bundlePrice;
    let newBalance = client.tickets.balance + qty;
    const now = new Date().toISOString();
    const invoiceId = uid("INV");
    const repId = uid("TR");
    const txnId = uid("TT");

    const invoice: InvoiceData = {
      id: invoiceId,
      workOrderId: "",
      clientId,
      kind: "ticket-replenishment",
      lineItems: [
        {
          description: `Prepaid dump tickets · ${qty} bundle`,
          qty,
          rate: price / qty,
          amount: price,
        },
      ],
      total: price,
      qboSyncStatus: client.tickets.autoBillEnabled ? "pending" : "not-synced",
      qboInvoiceId: null,
    };
    const replenishment: TicketReplenishment = {
      id: repId,
      clientId,
      invoiceDataId: invoiceId,
      qty,
      amount: price,
      triggeredAt: now,
      autoBilled: client.tickets.autoBillEnabled,
      qboSyncStatus: invoice.qboSyncStatus,
      qboInvoiceId: null,
    };
    const txn: TicketTransaction = {
      id: txnId,
      clientId,
      kind: "credit",
      qty,
      balanceAfter: newBalance,
      occurredAt: now,
      workOrderId: null,
      vehicleId: null,
      dumpSite: null,
      reason: client.tickets.autoBillEnabled
        ? "Auto-replenishment fired"
        : "Manual top-up by admin",
    };

    if (USE_SUPABASE && supabase) {
      // Resolve the actor from the live session if the caller didn't pass one
      // (auto-replenish from debitTicketForWorkOrder threads the approver
      // through; admin UI calls just rely on auth.getUser()).
      let resolvedActor: string | null = actorId ?? null;
      if (!resolvedActor) {
        try {
          const { data: authData } = await supabase.auth.getUser();
          resolvedActor = authData.user?.id ?? null;
        } catch {
          // Fall through — the RPC will reject with insufficient_privilege
          // and we'll surface that via reportApiError below.
        }
      }
      if (!resolvedActor) {
        throw new Error(
          `topUp.actor: ${reportApiError("TOP_UP_TICKETS_RPC", { message: "no admin session for top-up" }, { clientId, invoiceId: invoice.id })}`,
        );
      }
      // Atomic 4-step write (invoice + line item + replenishment + transaction +
      // balance bump) delegated to the SECURITY DEFINER top_up_client_tickets
      // RPC. Eliminates the read-modify-write race on clients.tickets_balance
      // and guarantees the four child rows either all land or none do.
      const { data, error } = await supabase.rpc("top_up_client_tickets", {
        p_client_id: clientId,
        p_qty: qty,
        p_amount: price,
        p_invoice_id: invoice.id,
        p_replenish_id: replenishment.id,
        p_auto_billed: replenishment.autoBilled,
        p_actor_id: resolvedActor,
        p_notes: txn.reason,
      });
      if (error)
        throw new Error(
          `topUp.rpc: ${reportApiError("TOP_UP_TICKETS_RPC", error, { clientId, invoiceId: invoice.id, replenishmentId: replenishment.id })}`,
        );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.ok) {
        const rpcError: string = row?.error ?? "top_up_client_tickets returned ok=false";
        throw new Error(
          `topUp.rpc: ${reportApiError("TOP_UP_TICKETS_RPC", { message: rpcError }, { clientId, invoiceId: invoice.id, replenishmentId: replenishment.id })}`,
        );
      }
      // Mirror the RPC-authoritative ids/balance back onto the domain objects
      // we're about to hand to the local store so the cache matches the DB.
      if (typeof row.new_balance === "number") {
        newBalance = row.new_balance;
        txn.balanceAfter = row.new_balance;
      }
      if (typeof row.transaction_id === "string") {
        txn.id = row.transaction_id;
      }
    } else {
      await wait();
    }

    const store = getStore();
    store.recordTicketTransaction(txn);
    store.recordTicketReplenishment(replenishment, invoice);
    store.updateClientTicketSettings(clientId, { balance: newBalance });
    return replenishment;
  },

  // ---- Ticket photos (driver upload + admin manual entry) ----------------

  /**
   * Mint a fresh signed URL for a ticket photo stored under `path`. Views
   * call this on every render so the URL never expires from under the
   * `<img>`. Returns null when running on mocks (the photo_url is then the
   * raw data URL).
   */
  signTicketPhotoUrl: async (path: string, ttlSeconds = 3600): Promise<string | null> => {
    if (!USE_SUPABASE || !supabase) return null;
    // Data URLs (mock mode) round-trip unchanged.
    if (path.startsWith("data:") || path.startsWith("http")) return path;
    const { data, error } = await supabase.storage
      .from("ticket-photos")
      .createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) {
      console.warn("signTicketPhotoUrl failed:", error?.message);
      return null;
    }
    return data.signedUrl;
  },

  /**
   * Driver-side: convert the captured data URL to a Blob, upload to the
   * `ticket-photos` Storage bucket under <driverId>/<jobId>-<random>.jpg,
   * mint a 30-day signed URL, and insert a `ticket_photos` row in
   * `awaiting-entry`. Returns the domain TicketPhoto so the caller can
   * push it onto local state immediately. When Supabase is unavailable we
   * just synthesize a row with the data URL — keeps the mock UX intact.
   */
  uploadTicketPhoto: async (input: {
    driverId: string;
    jobId: string;
    dataUrl: string;
    idempotencyKey?: string;
  }): Promise<TicketPhoto> => {
    const id = uid("TP");
    if (USE_SUPABASE && supabase) {
      const blob = await fetch(input.dataUrl).then((r) => r.blob());
      // Short, opaque suffix — the path is private to the bucket and the
      // driverId prefix prevents cross-driver collisions, so 8 chars from a
      // UUID is plenty.
      const suffix = crypto.randomUUID().slice(0, 8);
      const path = `${input.driverId}/${input.jobId}-${suffix}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("ticket-photos")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (upErr)
        throw new Error(
          `uploadTicketPhoto.storage: ${reportApiError("UPLOAD_TICKET_PHOTO_STORAGE", upErr, { driverId: input.driverId, jobId: input.jobId })}`,
        );
      // Persist the storage PATH (not a signed URL) so views can mint a fresh
      // signed URL on demand. A baked-in 30-day URL would 403 on day 31 and
      // every admin <img> would silently break.
      const uploadedAt = new Date().toISOString();
      let persistedId = id;
      let persistedPath = path;
      let persistedUploadedAt = uploadedAt;
      try {
        const persisted = await insertWithIdempotency("ticket_photos", {
          id,
          driver_id: input.driverId,
          job_id: input.jobId,
          photo_url: path,
          status: "awaiting-entry",
          uploaded_at: uploadedAt,
          idempotency_key: input.idempotencyKey,
        });
        // If the helper deduped to an existing row, prefer its persisted
        // id / photo_url / uploaded_at so the local store mirror and the
        // returned domain object reflect the canonical first-write. The
        // freshly-uploaded blob at `path` is an orphan in that case; an
        // out-of-band storage GC can sweep it later (this is rare enough
        // — only happens on retries-after-lost-response — that we'd rather
        // accept a tiny amount of bucket cruft than risk double-inserting
        // a ticket_photos row that admins would have to manually reconcile).
        const r = persisted as { id?: string; photo_url?: string; uploaded_at?: string };
        if (r.id) persistedId = r.id;
        if (r.photo_url) persistedPath = r.photo_url;
        if (r.uploaded_at) persistedUploadedAt = r.uploaded_at;
      } catch (insErr) {
        const e = insErr as {
          message: string;
          details?: string | null;
          hint?: string | null;
          code?: string | null;
        };
        throw new Error(
          `uploadTicketPhoto.insert: ${reportApiError("UPLOAD_TICKET_PHOTO_INSERT", e, { id })}`,
        );
      }
      const photo: TicketPhoto = {
        id: persistedId,
        jobId: input.jobId,
        driverId: input.driverId,
        photoUrl: persistedPath,
        weight: null,
        location: null,
        enteredBy: null,
        status: "awaiting-entry",
        uploadedAt: persistedUploadedAt,
      };
      getStore().addTicketPhoto(photo);
      return photo;
    }
    await wait();
    const photo: TicketPhoto = {
      id,
      jobId: input.jobId,
      driverId: input.driverId,
      photoUrl: input.dataUrl,
      weight: null,
      location: null,
      enteredBy: null,
      status: "awaiting-entry",
      uploadedAt: new Date().toISOString(),
    };
    getStore().addTicketPhoto(photo);
    return photo;
  },

  // ---- Work order photos --------------------------------------------------

  /**
   * Mint a fresh signed URL for a work order photo stored under `path`.
   * Mirrors signTicketPhotoUrl — returns null in mock mode (the photoUrl is
   * then the raw data URL already usable as an <img> src).
   */
  signWorkOrderPhotoUrl: async (path: string, ttlSeconds = 3600): Promise<string | null> => {
    if (!USE_SUPABASE || !supabase) return null;
    if (path.startsWith("data:") || path.startsWith("http")) return path;
    const { data, error } = await supabase.storage
      .from("wo-photos")
      .createSignedUrl(path, ttlSeconds);
    if (error || !data?.signedUrl) {
      console.warn("signWorkOrderPhotoUrl failed:", error?.message);
      return null;
    }
    return data.signedUrl;
  },

  /**
   * Mechanic-side: convert the captured data URL to a Blob, upload to the
   * `wo-photos` Storage bucket under <workOrderId>/<random>.jpg, and insert a
   * `maintenance_work_order_photos` row. Mirrors uploadTicketPhoto — the
   * storage PATH is persisted, not a baked signed URL (which would 403 after
   * expiry). Mock mode synthesizes a row with the data URL directly.
   */
  uploadWorkOrderPhoto: async (input: {
    workOrderId: string;
    mechanicId: string;
    dataUrl: string;
  }): Promise<WorkOrderPhoto> => {
    const id = uid("WOP");
    if (USE_SUPABASE && supabase) {
      const blob = await fetch(input.dataUrl).then((r) => r.blob());
      const suffix = crypto.randomUUID().slice(0, 8);
      const path = `${input.workOrderId}/${suffix}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("wo-photos")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (upErr)
        throw new Error(
          `uploadWorkOrderPhoto.storage: ${reportApiError("UPLOAD_WO_PHOTO_STORAGE", upErr, { workOrderId: input.workOrderId })}`,
        );
      const uploadedAt = new Date().toISOString();
      const { data, error: insErr } = await supabase
        .from("maintenance_work_order_photos")
        .insert({
          id,
          work_order_id: input.workOrderId,
          mechanic_id: input.mechanicId,
          photo_url: path,
          uploaded_at: uploadedAt,
        })
        .select()
        .single();
      if (insErr)
        throw new Error(
          `uploadWorkOrderPhoto.insert: ${reportApiError("UPLOAD_WO_PHOTO_INSERT", insErr, { id })}`,
        );
      const photo = dbWorkOrderPhotoToDomain(data);
      getStore().addWorkOrderPhoto(photo);
      return photo;
    }
    await wait();
    const photo: WorkOrderPhoto = {
      id,
      workOrderId: input.workOrderId,
      mechanicId: input.mechanicId,
      photoUrl: input.dataUrl,
      uploadedAt: new Date().toISOString(),
    };
    getStore().addWorkOrderPhoto(photo);
    return photo;
  },

  /**
   * Driver-side: record a prepaid-ticket debit for a client. Used by the
   * /driver/tickets greenfield route (the QR-scanned-ticket-book landing).
   * Mirrors the auto-debit logic in debitTicketForWorkOrder but without an
   * approved work order — the trigger here is the driver standing at a
   * client's site and pulling a ticket from their prepaid book.
   *
   * Calls the SECURITY DEFINER record_driver_ticket_use RPC for the atomic
   * decrement + ticket_transactions insert. That RPC is role-gated to
   * driver/mechanic/admin (the older debit_client_ticket RPC is admin-only
   * and rejected drivers), reads auth.uid() internally so we don't pass an
   * actor id, and writes work_order_id = NULL server-side so the FK to
   * work_orders is never exercised on this bare-site flow.
   *
   * Returns { newBalance, transactionId } on success. Throws when the
   * client isn't found or any of the RPC validations fail.
   */
  recordTicketUse: async (input: {
    clientId: string;
    tickets: number;
    vehicleId: string;
    dumpSite: string;
    notes?: string;
    actorId: string;
    idempotencyKey?: string;
  }): Promise<{ newBalance: number; transactionId: string }> => {
    const store = getStore();
    const client = store.clients.find((c) => c.id === input.clientId);
    if (!client) {
      throw new Error(`recordTicketUse: client ${input.clientId} not found`);
    }
    const ticketsToDebit = Math.max(1, Math.min(20, Math.floor(input.tickets)));
    let newBalance = client.tickets.balance - ticketsToDebit;
    let transactionId = uid("TT");
    const occurredAt = new Date().toISOString();

    // Build the audit-trail reason BEFORE the RPC call so it can be passed as
    // p_reason — the new record_driver_ticket_use RPC stores it on
    // ticket_transactions.reason verbatim, and the local mirror below uses
    // the same string for parity with the server row.
    const reasonParts = ["Ticket pulled at site"];
    if (input.notes && input.notes.trim()) {
      reasonParts.push(input.notes.trim());
    }
    if (newBalance < 0) {
      reasonParts.push("balance went negative");
    }
    const reason = reasonParts.join(" · ");

    if (USE_SUPABASE && supabase) {
      // record_driver_ticket_use is the driver-callable replacement for the
      // admin-gated debit_client_ticket RPC. It reads auth.uid() internally
      // (so we do NOT pass p_actor_id) and writes work_order_id = NULL
      // server-side (so we do NOT pass p_work_order_id). See migration
      // 20260602152307_fix_tickets_rpc_and_realtime.sql.
      const { data, error } = await supabase.rpc("record_driver_ticket_use", {
        p_client_id: input.clientId,
        p_vehicle_id: input.vehicleId,
        p_dump_site: input.dumpSite,
        p_tickets: ticketsToDebit,
        p_reason: reason,
      });
      if (error) {
        throw new Error(
          `recordTicketUse.rpc: ${reportApiError("RECORD_TICKET_USE_RPC", error, { clientId: input.clientId, tickets: ticketsToDebit })}`,
        );
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.ok) {
        const rpcError: string = row?.error ?? "record_driver_ticket_use returned ok=false";
        throw new Error(
          `recordTicketUse.rpc: ${reportApiError("RECORD_TICKET_USE_RPC", { message: rpcError }, { clientId: input.clientId, tickets: ticketsToDebit })}`,
        );
      }
      newBalance = row.new_balance ?? newBalance;
      transactionId = row.transaction_id ?? transactionId;
    } else {
      await wait();
    }

    const txn: TicketTransaction = {
      id: transactionId,
      clientId: input.clientId,
      kind: "debit",
      qty: ticketsToDebit,
      balanceAfter: newBalance,
      occurredAt,
      // No work order — this is the bare-site flow. The RPC writes NULL
      // server-side and the local mirror matches.
      workOrderId: null,
      vehicleId: input.vehicleId || null,
      dumpSite: input.dumpSite || null,
      reason,
    };
    // Local store mirror — appends the RPC-returned transaction_id to in-memory
    // ticket_transactions state. Does NOT perform a second supabase insert; the
    // server row was already written atomically inside the RPC.
    store.recordTicketTransaction(txn);
    store.updateClientTicketSettings(input.clientId, { balance: newBalance });

    // Threshold crossing notification — mirrors debitTicketForWorkOrder so
    // the admin alert fires regardless of which path drained the balance.
    if (
      client.tickets.balance > client.tickets.threshold &&
      newBalance <= client.tickets.threshold
    ) {
      const note: Notification = {
        id: uid("NOTIF"),
        userId: "admin",
        type: "alert",
        body: `${client.name} ticket balance is ${newBalance} (threshold ${client.tickets.threshold}).`,
        link: "/admin/prepaid-tickets",
        readAt: null,
        createdAt: new Date().toISOString(),
      };
      store.pushNotification(note);
    }

    return { newBalance, transactionId };
  },

  /**
   * Admin-side: persist weight + dump location for a ticket photo. The
   * status flips to "entered" automatically once both fields are present so
   * the admin queue's "awaiting entry" tab shrinks as work happens.
   */
  updateTicketPhoto: async (
    id: string,
    patch: {
      weight?: number | null;
      location?: string | null;
      status?: TicketPhoto["status"];
      enteredBy?: string | null;
    },
  ): Promise<{ ok: true }> => {
    // Derive the next status from the patch when the caller didn't pin it
    // explicitly — having both weight and a non-empty location means the
    // photo is fully entered.
    const nextStatus: TicketPhoto["status"] =
      patch.status ??
      (patch.weight != null && patch.location != null && patch.location !== ""
        ? "entered"
        : "awaiting-entry");
    if (USE_SUPABASE && supabase) {
      const { error } = await supabase
        .from("ticket_photos")
        .update({
          ...(patch.weight !== undefined && { weight: patch.weight }),
          ...(patch.location !== undefined && { location: patch.location }),
          ...(patch.enteredBy !== undefined && { entered_by: patch.enteredBy }),
          status: nextStatus,
        })
        .eq("id", id);
      if (error)
        throw new Error(
          `updateTicketPhoto: ${reportApiError("UPDATE_TICKET_PHOTO", error, { id })}`,
        );
    } else {
      await wait();
    }
    getStore().updateTicketPhoto(id, {
      ...(patch.weight !== undefined && { weight: patch.weight }),
      ...(patch.location !== undefined && { location: patch.location }),
      ...(patch.enteredBy !== undefined && { enteredBy: patch.enteredBy }),
      status: nextStatus,
    });
    return { ok: true };
  },

  // ---- Offline queue dead-letter ----------------------------------------
  // Called by offline-queue.ts when an item has exhausted MAX_RETRIES.
  // Inserts the poisoned payload into public.dead_letter_submissions so an
  // admin can review on /admin/errors instead of silently re-queuing forever.
  // Throws on failure — the queue keeps the item locally and retries the move
  // later (e.g. when connectivity returns) rather than dropping data on the
  // floor.
  moveToDeadLetter: async (item: {
    id: string;
    kind: string;
    payload: unknown;
    queuedAt: string;
    retryCount: number;
    lastError: string | null;
    lastAttemptAt: string | null;
  }): Promise<{ ok: true }> => {
    if (USE_SUPABASE && supabase) {
      // user_id is best-effort: an offline driver may not have a fresh
      // session, so fall back to null and let RLS / admin reconciliation
      // handle attribution.
      let userId: string | null = null;
      try {
        const { data } = await supabase.auth.getUser();
        userId = data.user?.id ?? null;
      } catch {
        userId = null;
      }
      const { error } = await supabase.from("dead_letter_submissions").insert({
        kind: item.kind,
        payload: JSON.parse(JSON.stringify(item.payload)) as import("./database.types").Json,
        queued_at: item.queuedAt,
        retry_count: item.retryCount,
        last_error: item.lastError,
        last_attempt_at: item.lastAttemptAt,
        user_id: userId,
      });
      if (error)
        throw new Error(
          `moveToDeadLetter: ${reportApiError("MOVE_TO_DEAD_LETTER", error, { queueItemId: item.id, kind: item.kind })}`,
        );
    } else {
      await wait(50);
    }
    return { ok: true };
  },

  // Admin "Mark resolved" action from /admin/errors → Errors tab. Stamps
  // public.error_log with resolved_at = now(), resolved_by = auth.uid(), and
  // optional notes. Returns { ok: false, reason } instead of throwing so the
  // route can surface a precise toast.
  resolveError: async (
    errorId: string,
    notes?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      return { ok: false, reason: "supabase unavailable" };
    }
    try {
      let userId: string | null = null;
      try {
        const { data } = await supabase.auth.getUser();
        userId = data.user?.id ?? null;
      } catch {
        userId = null;
      }
      const { error } = await supabase
        .from("error_log")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: userId,
          resolution_notes: notes ?? null,
        })
        .eq("id", errorId);
      if (error) {
        reportApiError("RESOLVE_ERROR", error, { errorId });
        return { ok: false, reason: error.message };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportApiError("RESOLVE_ERROR", { message: msg }, { errorId });
      return { ok: false, reason: msg };
    }
  },

  // Admin "Requeue" action from /admin/errors → Dead-letter queue tab.
  // Reads the dead-lettered row, drops it back into the localStorage offline
  // queue with retryCount=0, and deletes the DLQ row. The next online flush
  // (or a manual "Retry now") re-attempts the original submission. Throws on
  // failure so the UI can surface a real error rather than a silent no-op.
  requeueDeadLetter: async (
    deadLetterId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!USE_SUPABASE || !supabase) {
      return { ok: false, reason: "supabase unavailable" };
    }
    try {
      const { data: row, error: selErr } = await supabase
        .from("dead_letter_submissions")
        .select("id, kind, payload, retry_count, queued_at, user_id, last_attempt_at")
        .eq("id", deadLetterId)
        .maybeSingle();
      if (selErr) {
        reportApiError("REQUEUE_DEAD_LETTER_SELECT", selErr, { deadLetterId });
        return { ok: false, reason: selErr.message };
      }
      if (!row) return { ok: false, reason: "already requeued or removed" };

      // Delete-first-then-enqueue makes the operation safe under concurrent
      // admin clicks: only the request whose DELETE actually affects one row
      // is allowed to enqueue. If anything goes wrong with the enqueue we
      // restore the row to the DLQ in the catch block below.
      const { data: deleted, error: delErr } = await supabase
        .from("dead_letter_submissions")
        .delete()
        .eq("id", deadLetterId)
        .select("id");
      if (delErr) {
        reportApiError("REQUEUE_DEAD_LETTER_DELETE", delErr, { deadLetterId });
        return { ok: false, reason: delErr.message };
      }
      if (!deleted || deleted.length !== 1) {
        return { ok: false, reason: "already requeued by another admin" };
      }

      try {
        // Lazy import — offline-queue imports api, so a top-level import
        // would create a circular dependency.
        const { offlineQueue } = await import("./offline-queue");
        await offlineQueue.enqueue({
          kind: row.kind as Parameters<typeof offlineQueue.enqueue>[0]["kind"],
          payload: row.payload as Parameters<typeof offlineQueue.enqueue>[0]["payload"],
        });
      } catch (enqErr) {
        const enqMsg = enqErr instanceof Error ? enqErr.message : String(enqErr);
        reportApiError(
          "REQUEUE_DEAD_LETTER_ENQUEUE",
          { message: enqMsg },
          { rowId: deadLetterId, payloadPreview: JSON.stringify(row.payload).slice(0, 500) },
        );
        await supabase.from("dead_letter_submissions").insert({
          id: row.id,
          kind: row.kind,
          payload: row.payload,
          retry_count: row.retry_count ?? 0,
          queued_at: row.queued_at,
          user_id: row.user_id ?? null,
          last_attempt_at: row.last_attempt_at ?? null,
          last_error: "Requeue failed: " + enqMsg,
        });
        return { ok: false, reason: "enqueue failed; row restored to DLQ" };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reportApiError("REQUEUE_DEAD_LETTER", { message: msg }, { deadLetterId });
      return { ok: false, reason: msg };
    }
  },
};

// =============================================================================
// Pre-trip lockout helper — picks the most recent passing inspection for a
// driver+vehicle pair so submitStartOfDay can stamp time_entries.pretripInspectionId.
// Returns null when no passing inspection exists (the lockout screen should
// have prevented submission in that case).
// =============================================================================
function mostRecentPassingInspectionId(
  inspections: VehicleInspection[],
  driverId: string,
  vehicleId: string,
): string | null {
  let best: VehicleInspection | null = null;
  for (const ins of inspections) {
    if (ins.driverId !== driverId || ins.vehicleId !== vehicleId || ins.flagged) continue;
    if (!best || new Date(ins.submittedAt).getTime() > new Date(best.submittedAt).getTime()) {
      best = ins;
    }
  }
  return best?.id ?? null;
}

// =============================================================================
// Rate-table lookup used by approveWorkOrder. Matches by unit (exact) and
// description (case-insensitive substring) so admins can type "Concrete" /
// "Concrete removal" and still hit the right row for a "Concrete" load type.
// Returns null when the client has no rate table OR the table has no row that
// matches the load type — the caller decides whether to fall back to 24 and
// log a warning so billing can patch the rate sheet.
// =============================================================================
function resolveLineItemRate(
  loadType: string,
  preferredUnit: RateLineItem["unit"],
  rateTableId: string | null,
  rateTables: { id: string; lineItems: RateLineItem[] }[],
): { rate: number; unit: RateLineItem["unit"] } | null {
  if (!rateTableId) return null;
  const table = rateTables.find((rt) => rt.id === rateTableId);
  if (!table) return null;
  const needle = loadType.trim().toLowerCase();
  if (!needle) return null;
  const isDescriptionMatch = (li: RateLineItem) =>
    li.description.toLowerCase().includes(needle) || needle.includes(li.description.toLowerCase());
  // Try the preferred unit first (e.g. 'tonne' for a weight-based WO), then
  // fall back through load -> flat -> hour. A client rate sheet that only
  // lists 'load' or 'flat' pricing for this load type still resolves so the
  // approval picks up real billing instead of $24/tonne.
  const order: RateLineItem["unit"][] = [preferredUnit, "load", "flat", "hour", "tonne"];
  for (const unit of order) {
    const match = table.lineItems.find((li) => li.unit === unit && isDescriptionMatch(li));
    if (match) return { rate: match.rate, unit: match.unit };
  }
  return null;
}

// =============================================================================
// Internal helpers used by approveWorkOrder for auto-debit + auto-replenish
// =============================================================================
async function debitTicketForWorkOrder(
  workOrderId: string,
  clientId: string,
  vehicleId: string | null,
  dumpSite: string,
  actorId: string,
) {
  const store = getStore();
  const client = store.clients.find((c) => c.id === clientId);
  if (!client || !client.tickets.enabled) return;

  let newBalance = client.tickets.balance - 1;
  let txnId = uid("TT");
  const occurredAt = new Date().toISOString();

  if (USE_SUPABASE && supabase) {
    // Atomic decrement + ticket_transactions insert via the SECURITY DEFINER
    // debit_client_ticket RPC. Eliminates the read-modify-write race on
    // clients.tickets_balance and gives us a consistent post-state to mirror
    // back into the local store.
    const { data, error } = await supabase.rpc("debit_client_ticket", {
      p_client_id: clientId,
      p_work_order_id: workOrderId,
      p_vehicle_id: vehicleId ?? "",
      p_dump_site: dumpSite || "",
      p_tickets: 1,
      p_actor_id: actorId,
    });
    if (error)
      throw new Error(
        `debitTicketForWorkOrder.rpc: ${reportApiError("DEBIT_CLIENT_TICKET_RPC", error, { workOrderId, clientId })}`,
      );
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.ok) {
      const rpcError: string = row?.error ?? "debit_client_ticket returned ok=false";
      throw new Error(
        `debitTicketForWorkOrder.rpc: ${reportApiError("DEBIT_CLIENT_TICKET_RPC", { message: rpcError }, { workOrderId, clientId })}`,
      );
    }
    newBalance = row.new_balance ?? newBalance;
    txnId = row.transaction_id ?? txnId;
  }

  const txn: TicketTransaction = {
    id: txnId,
    clientId,
    kind: "debit",
    qty: 1,
    balanceAfter: newBalance,
    occurredAt,
    workOrderId,
    vehicleId,
    dumpSite: dumpSite || null,
    reason: newBalance < 0 ? "Work order approved · balance went negative" : "Work order approved",
  };

  store.recordTicketTransaction(txn);
  store.updateClientTicketSettings(clientId, { balance: newBalance });

  // Threshold check: if we just crossed, auto-replenish (or alert only)
  const crossed =
    client.tickets.balance > client.tickets.threshold && newBalance <= client.tickets.threshold;
  if (crossed && client.tickets.autoBillEnabled) {
    await api.topUpTickets(clientId, client.tickets.bundleSize, actorId);
    const note: Notification = {
      id: uid("NOTIF"),
      userId: "admin",
      type: "alert",
      body: `Auto-bill fired: ${client.name} replenished ${client.tickets.bundleSize} tickets.`,
      link: "/admin/prepaid-tickets",
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    store.pushNotification(note);
  } else if (newBalance <= client.tickets.threshold) {
    const note: Notification = {
      id: uid("NOTIF"),
      userId: "admin",
      type: "alert",
      body: `${client.name} ticket balance is ${newBalance} (threshold ${client.tickets.threshold}).`,
      link: "/admin/prepaid-tickets",
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    store.pushNotification(note);
  }
}

export type Api = typeof api;
