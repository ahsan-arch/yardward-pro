import type {
  Job,
  WorkOrder,
  PurchaseRequest,
  ToolChecklistSubmission,
  TimeEntry,
  SmsLog,
  DriverToken,
  InvoiceData,
  TokenScope,
  ToolChecklistItem,
  VehicleInspection,
} from "@/types/domain";
import { getStore } from "@/contexts/DataContext";
import { driverById, jobById, clientById, geotabCoordsForVehicle } from "@/data/mockData";

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

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
  createJob: async (input: Omit<Job, "id" | "createdAt">) => {
    await wait();
    const job: Job = { ...input, id: uid("JOB"), createdAt: new Date().toISOString() };
    getStore().createJob(job);
    return job;
  },
  updateJob: async (id: string, patch: Partial<Job>) => {
    await wait();
    getStore().updateJob(id, patch);
    return { ok: true };
  },
  assignJob: async (jobId: string, driverId: string, vehicleId: string) => {
    await wait();
    const s = getStore();
    s.updateJob(jobId, { driverId, vehicleId });
    const j = s.jobs.find((x) => x.id === jobId) ?? jobById(jobId);
    const driver = driverById(driverId);
    const body = `${jobId} assigned · ${j?.location.address ?? ""} · ${j?.scheduledAt.slice(11, 16) ?? ""}`;
    await api.sendSms(driver?.id ?? driverId, body, jobId);
    return { ok: true };
  },

  // Work orders
  submitWorkOrder: async (input: Omit<WorkOrder, "id" | "submittedAt" | "status">) => {
    await wait();
    const wo: WorkOrder = {
      ...input,
      id: uid("WO"),
      submittedAt: new Date().toISOString(),
      status: "pending",
    };
    getStore().submitWorkOrder(wo);
    return wo;
  },
  approveWorkOrder: async (id: string, approverId: string) => {
    await wait();
    const s = getStore();
    const wo = s.workOrders.find((w) => w.id === id);
    const j = wo ? jobById(wo.jobId) : undefined;
    const c = j ? clientById(j.clientId) : undefined;
    const invoice: InvoiceData = {
      id: uid("INV"),
      workOrderId: id,
      clientId: c?.id ?? "",
      lineItems: wo
        ? [
            {
              description: `${wo.loadType} haul`,
              qty: wo.weightTonnes,
              rate: 24,
              amount: wo.weightTonnes * 24,
            },
          ]
        : [],
      total: wo ? wo.weightTonnes * 24 : 0,
      qboSyncStatus: "pending",
      qboInvoiceId: null,
    };
    s.approveWorkOrder(id, approverId, invoice);
    return invoice;
  },
  rejectWorkOrder: async (id: string, reason: string) => {
    await wait();
    getStore().rejectWorkOrder(id, reason);
    return { ok: true };
  },

  // Driver forms
  submitStartOfDay: async (p: {
    driverId: string;
    odometer: number;
    fuelLevel: string;
    condition: string;
    gps: { lat: number; lng: number } | null;
  }) => {
    await wait();
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
    };
    getStore().submitStartOfDay(entry);
    return entry;
  },
  submitEndOfDay: async (p: {
    driverId: string;
    odometer: number;
    fuelLevel: string;
    summary: string;
    gps: { lat: number; lng: number } | null;
  }) => {
    await wait();
    const s = getStore();
    const open = s.timeEntries.find((t) => t.driverId === p.driverId && !t.clockOut);
    if (open) s.submitEndOfDay(open.id, { clockOut: new Date().toISOString(), gpsClockOut: p.gps });
    return { ok: true };
  },
  submitToolChecklist: async (
    input: Omit<ToolChecklistSubmission, "id" | "submittedAt"> & { items: ToolChecklistItem[] },
  ) => {
    await wait();
    const s: ToolChecklistSubmission = {
      ...input,
      id: uid("TCS"),
      submittedAt: new Date().toISOString(),
    };
    getStore().submitToolChecklist(s);
    return s;
  },

  // Time tracking
  clockIn: async (
    driverId: string,
    gps: { lat: number; lng: number } | null,
    _odometer: number,
  ) => {
    await wait();
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
    getStore().clockIn(entry);
    return entry;
  },
  clockOut: async (
    entryId: string,
    gps: { lat: number; lng: number } | null,
    _odometer: number,
  ) => {
    await wait();
    getStore().clockOut(entryId, { clockOut: new Date().toISOString(), gpsClockOut: gps });
    return { ok: true };
  },

  // Vehicle inspection
  submitVehicleInspection: async (input: Omit<VehicleInspection, "id" | "submittedAt">) => {
    await wait();
    const inspection: VehicleInspection = {
      ...input,
      id: uid("INS"),
      submittedAt: new Date().toISOString(),
    };
    getStore().submitVehicleInspection(inspection);
    return inspection;
  },

  // Mechanic
  submitPurchaseRequest: async (input: Omit<PurchaseRequest, "id" | "createdAt" | "status">) => {
    await wait();
    const pr: PurchaseRequest = {
      ...input,
      id: uid("PR"),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    getStore().submitPurchaseRequest(pr);
    return pr;
  },
  approvePurchaseRequest: async (id: string, approverId: string) => {
    await wait();
    getStore().approvePurchaseRequest(id, approverId);
    return { ok: true };
  },

  // Integrations (stubs)
  sendSms: async (driverId: string, body: string, jobId?: string) => {
    await wait(100);
    const sms: SmsLog = {
      id: uid("SMS"),
      driverId,
      jobId: jobId ?? null,
      body,
      sentAt: new Date().toISOString(),
      twilioMessageId: `SM${Math.random().toString(36).slice(2, 8)}`,
      deliveryStatus: "sent",
    };
    getStore().addSms(sms);
    return sms;
  },
  fetchGeotabLocation: async (vehicleId: string) => {
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
  fetchGeotabTelematics: async (_vehicleId: string) =>
    Promise.resolve({ odometer: 0, engineHours: 0 }),
  pushInvoiceToQbo: async (_invoiceDataId: string) => {
    await wait();
    return { ok: true };
  },

  // Tokens
  generateDriverToken: async (driverId: string, scope: TokenScope, expiresInHours: number) => {
    await wait();
    const t: DriverToken = {
      id: uid("TKN"),
      driverId,
      token: `tok_${Math.random().toString(36).slice(2, 14)}`,
      scopedTo: scope,
      expiresAt: new Date(Date.now() + expiresInHours * 3600_000).toISOString(),
      usedAt: null,
    };
    getStore().generateDriverToken(t);
    return t;
  },
  validateDriverToken: async (token: string) => {
    await wait(100);
    const found = getStore().driverTokens.find((t) => t.token === token);
    const expired = found ? new Date(found.expiresAt).getTime() < Date.now() : true;
    return { valid: !!found && !found.usedAt && !expired, token: found ?? null };
  },
};

export type Api = typeof api;
