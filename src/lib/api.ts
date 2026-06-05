import type {
  Job,
  JobLog,
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
} from "@/types/domain";
import { DEFAULT_APP_SETTINGS } from "@/types/domain";
import { getStore } from "@/contexts/DataContext";
import { driverById, jobById, clientById, geotabCoordsForVehicle } from "@/data/mockData";
import { supabase, USE_SUPABASE, type Row } from "./supabase";
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

// Small helper: log the supabase error to the server and return the message we
// will throw to callers. Keeps each call site to two lines instead of five.
function reportApiError(
  errorCode: string,
  err: { message: string; details?: string | null; hint?: string | null; code?: string | null } | null | undefined,
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
  dbMaintenanceWorkOrderToDomain,
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
    | "purchase_requests"
    | "ticket_photos"
    | "maintenance_work_orders",
  row: T,
): Promise<T> {
  if (!supabase) throw new Error(`insertWithIdempotency: supabase client unavailable`);
  // `.insert(row).select().single()` round-trips the inserted row so we have
  // the persisted values (including server-side defaults like `created_at`)
  // to hand back to the caller. We need the .single() shape either way to
  // get a structured 23505 PostgrestError on a partial-unique-index collision
  // instead of a silently-empty `data` array.
  const { data, error } = await supabase
    .from(table)
    .insert(row as never)
    .select()
    .single();
  if (!error) return data as unknown as T;
  // 23505 = unique_violation. We only swallow it for the idempotency_key
  // path — any other unique-constraint hit (e.g. pk collision on `id`) is
  // a real bug and must propagate.
  if (error.code === "23505" && row.idempotency_key) {
    const { data: existing, error: selErr } = await supabase
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
      const { error } = await supabase
        .from("clients")
        .insert(domainClientToDb(client));
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
      const { error } = await supabase.from("jobs").insert(domainJobToDb(job));
      if (error) throw new Error(`createJob: ${reportApiError("CREATE_JOB", error, { jobId: job.id })}`);
    } else {
      await wait();
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
      if (error) throw new Error(`updateJob: ${reportApiError("UPDATE_JOB", error, { jobId: id })}`);
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
    await api.sendSms(driver?.id ?? driverId, body, jobId);
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
      const sms = await api.sendSms(driver?.id ?? existing.driverId, body, jobId);
      return { ok: true, sms };
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
        const e = err as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
        const e = err as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
    const c = j ? (s.clients.find((x) => x.id === j.clientId) ?? clientById(j.clientId)) : undefined;
    // Resolve the per-tonne rate from the client's rate table. Falls back to
    // the legacy 24/tonne flat rate (with a console.warn) so a missing or
    // unmatched table never blocks approval — but it does surface the gap so
    // billing can patch the rate sheet.
    const matched = wo
      ? resolveLineItemRate(wo.loadType, "tonne", c?.rateTableId ?? null, s.rateTables)
      : null;
    const lineRate = matched?.rate ?? 24;
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
    const invoice: InvoiceData = {
      id: uid("INV"),
      workOrderId: id,
      clientId: c?.id ?? "",
      kind: "work-order",
      lineItems: wo
        ? [
            {
              description: `${wo.loadType} haul`,
              qty: wo.weightTonnes,
              rate: lineRate,
              amount: wo.weightTonnes * lineRate,
            },
          ]
        : [],
      total: wo ? wo.weightTonnes * lineRate : 0,
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
      debitTicketForWorkOrder(id, c.id, j?.vehicleId ?? null, wo.dumpSite, approverId).catch((err) =>
        console.warn("ticket debit failed:", err.message),
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
  }) => {
    const store = getStore();
    // Tie the shift back to the passing pre-trip that authorised it. The
    // lockout screen in driver.start-of-day.tsx blocks submission until a
    // fresh circle-check exists for the driver's assigned vehicle, so this
    // lookup is just recording the audit trail (and stays null only for
    // drivers without a vehicle assignment).
    const driver = store.drivers.find((d) => d.id === p.driverId);
    const vehicleId = driver?.vehicleAssignmentId ?? null;
    const pretripInspectionId = vehicleId
      ? mostRecentPassingInspectionId(store.vehicleInspections, p.driverId, vehicleId)
      : null;
    const entry: TimeEntry = {
      id: uid("TE"),
      driverId: p.driverId,
      clockIn: new Date().toISOString(),
      clockOut: null,
      gpsClockIn: p.gps,
      gpsClockOut: null,
      vehicleMovementCorrelation: "pending",
      flagged: p.condition !== "ok",
      flagReason: p.condition !== "ok" ? `Condition: ${p.condition}` : "",
      pretripInspectionId,
    };
    if (USE_SUPABASE && supabase) {
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
        flagged: entry.flagged,
        flag_reason: entry.flagReason,
        pretrip_inspection_id: entry.pretripInspectionId ?? null,
      });
      if (error)
        throw new Error(
          `submitStartOfDay: ${reportApiError("SUBMIT_START_OF_DAY", error, { driverId: p.driverId, entryId: entry.id, idempotencyKey: p.idempotencyKey ?? null })}`,
        );
    } else {
      await wait();
    }
    store.submitStartOfDay(entry);
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
      // Find the driver's open shift (clock_out IS NULL). Most-recent wins so
      // a stale row from a forgotten clock-out doesn't get re-closed in front
      // of today's row.
      const { data: open, error: selErr } = await supabase
        .from("time_entries")
        .select("*")
        .eq("driver_id", p.driverId)
        .is("clock_out", null)
        .order("clock_in", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (selErr)
        throw new Error(
          `submitEndOfDay.select: ${reportApiError("SUBMIT_END_OF_DAY_SELECT", selErr, { driverId: p.driverId })}`,
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
          `submitEndOfDay.update: ${reportApiError("SUBMIT_END_OF_DAY_UPDATE", updErr, { driverId: p.driverId, entryId: open.id, idempotencyKey: p.idempotencyKey ?? null })}`,
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
        const e = err as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
      if (error)
        throw new Error(
          `clockOut: ${reportApiError("CLOCK_OUT", error, { entryId })}`,
        );
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
      : new Date(now.getTime() - (lo + Math.floor(Math.random() * (hi - lo + 1))) * 1000).toISOString();
    const inspection: VehicleInspection = {
      ...input,
      id: uid("INS"),
      submittedAt,
    };

    if (USE_SUPABASE && supabase) {
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
        const e = insErr as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
      try {
        await insertWithIdempotency("purchase_requests", {
          id: pr.id,
          mechanic_id: pr.mechanicId,
          item: pr.item,
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
        const e = err as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
   * with at least one free unit, reserve one against it. The PR row stores
   * the reservation quantity (`inventory_decrement_qty`) so the admin sheet
   * can render "We reserved 1 of N in stock at SHOP-01" — and so the later
   * markPurchaseRequestOrdered call knows not to double-debit.
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
            it.name.toLowerCase().includes(needle) ||
            needle.includes(it.name.toLowerCase()) ||
            it.sku.toLowerCase().includes(needle) ||
            needle.includes(it.sku.toLowerCase()),
        )
      : [];
    const matched =
      candidates
        .filter((it) => it.qtyOnHand - it.qtyReserved >= 1)
        .sort((a, b) => a.name.length - b.name.length)[0] ?? null;
    const reservation = matched ? { itemId: matched.id, qty: 1 } : null;
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
      throw new Error(
        `markPurchaseRequestOrdered: PR ${id} is ${pr.status}, must be approved`,
      );

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
  sendSms: async (driverId: string, body: string, jobId?: string) => {
    if (USE_SUPABASE && supabase) {
      const driverPhone = getStore().drivers.find((d) => d.id === driverId)?.phone;
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
      capturedAt: new Date(Date.now() - 60_000 - (vehicleId.charCodeAt(0) % 5) * 60_000).toISOString(),
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
      const update: import("./database.types").Database["public"]["Tables"]["maintenance_work_orders"]["Update"] = {
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
          throw new MaintenanceWorkOrderError(
            "reassigned",
            "Work order was reassigned",
          );
        }
        throw new Error(
          "updateMaintenanceWorkOrder: row not found or not owned by mechanic",
        );
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
      throw new MaintenanceWorkOrderError(
        "release-failed",
        "not your work order to release",
      );
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
        const e = err as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
      const { error } = await supabase
        .from("qbo_employee_mappings")
        .upsert(
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
          notification_preferences: next.notificationPreferences as unknown as import("./database.types").Json,
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
  updateClientTicketSettings: async (
    clientId: string,
    patch: Partial<ClientTicketSettings>,
  ) => {
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
        const e = insErr as { message: string; details?: string | null; hint?: string | null; code?: string | null };
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
    li.description.toLowerCase().includes(needle) ||
    needle.includes(li.description.toLowerCase());
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
    client.tickets.balance > client.tickets.threshold &&
    newBalance <= client.tickets.threshold;
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
