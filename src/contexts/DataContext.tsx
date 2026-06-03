import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import * as seed from "@/data/mockData";
import { USE_SUPABASE, supabase, type Row } from "@/lib/supabase";
import { fetchAllFromSupabase } from "@/lib/db-queries";
import {
  dbJobToDomain,
  dbWorkOrderToDomain,
  dbNotificationToDomain,
  dbTicketPhotoToDomain,
  dbTimeEntryToDomain,
  dbVehicleToDomain,
  dbMaintenanceWorkOrderToDomain,
} from "@/lib/db-mappers";
import { useAuth } from "./AuthContext";
import type {
  Job,
  JobLog,
  WorkOrder,
  PurchaseRequest,
  ToolChecklistSubmission,
  TimeEntry,
  SmsLog,
  DriverToken,
  InvoiceData,
  TokenScope,
  VehicleInspection,
  Vehicle,
  Client,
  ClientTicketSettings,
  TicketTransaction,
  TicketReplenishment,
  TicketPhoto,
  Notification,
  AppSettings,
  RateTable,
  RateLineItem,
  MaintenanceLog,
  FuelLog,
  MaintenanceWorkOrder,
  Mechanic,
} from "@/types/domain";
import { DEFAULT_APP_SETTINGS } from "@/types/domain";

type Ctx = {
  drivers: typeof seed.drivers;
  /**
   * Mechanic roster. Hydrated from public.profiles WHERE role='mechanic' so
   * the name-lookup tables in mechanic.work-orders.tsx resolve real profile
   * UUIDs to real names instead of the "mechanic <suffix>" fallback. Mock
   * mode falls back to the seed.
   */
  mechanics: Mechanic[];
  vehicles: Vehicle[];
  clients: Client[];
  appSettings: AppSettings;
  rateTables: RateTable[];
  jobs: Job[];
  jobLogs: JobLog[];
  workOrders: WorkOrder[];
  invoiceData: InvoiceData[];
  maintenanceLogs: MaintenanceLog[];
  fuelLogs: FuelLog[];
  /**
   * Mechanic work-order queue. Distinct from `workOrders` (driver-side job
   * completion records) — these are vehicle repair tickets created by the
   * failed-inspection trigger, admin, or a driver_note, then claimed by a
   * mechanic from /mechanic/work-orders. Backed by maintenance_work_orders.
   */
  maintenanceWorkOrders: MaintenanceWorkOrder[];
  tools: typeof seed.tools;
  toolChecklistSubmissions: ToolChecklistSubmission[];
  purchaseRequests: PurchaseRequest[];
  inventoryItems: typeof seed.inventoryItems;
  /**
   * Mirror the qty_reserved bump that api.approvePurchaseRequest writes to
   * the inventory_items row when the requested item is in stock. Lets the
   * admin review sheet show the live "1 of N reserved" count without a
   * round-trip refetch.
   */
  adjustInventoryReservation: (inventoryItemId: string, qtyDelta: number) => void;
  smsLogs: SmsLog[];
  notifications: Notification[];
  driverTokens: DriverToken[];
  ticketPhotos: TicketPhoto[];
  tenders: typeof seed.tenders;
  timeEntries: TimeEntry[];
  vehicleInspections: VehicleInspection[];
  ticketTransactions: TicketTransaction[];
  ticketReplenishments: TicketReplenishment[];
  createJob: (job: Job) => void;
  updateJob: (id: string, patch: Partial<Job>) => void;
  /**
   * Prepend a freshly-submitted job log to local state so the admin job-detail
   * Sheet picks it up without waiting on a Supabase refetch.
   */
  submitJobLog: (log: JobLog) => void;
  submitWorkOrder: (wo: WorkOrder) => void;
  approveWorkOrder: (id: string, approverId: string, invoice: InvoiceData) => void;
  rejectWorkOrder: (id: string, reason: string) => void;
  submitToolChecklist: (s: ToolChecklistSubmission) => void;
  submitStartOfDay: (entry: TimeEntry) => void;
  submitEndOfDay: (entryId: string, patch: Partial<TimeEntry>) => void;
  submitPurchaseRequest: (req: PurchaseRequest) => void;
  /**
   * Marks the PR 'approved' and (when the approval reserved stock) records
   * the matched inventory item + the qty reserved against it. `inventory` is
   * passed in by api.approvePurchaseRequest after the fuzzy lookup so this
   * mutator stays the dumb state-writer (no business logic here).
   */
  approvePurchaseRequest: (
    id: string,
    approverId: string,
    inventory: { itemId: string; qty: number } | null,
  ) => void;
  /**
   * Flip an approved PR to 'ordered' once the admin places the supplier
   * order. Inventory was already reserved at approval, so we don't touch
   * stock here.
   */
  markPurchaseRequestOrdered: (
    id: string,
    ordererId: string,
    supplierOrderRef: string,
  ) => void;
  clockIn: (entry: TimeEntry) => void;
  clockOut: (entryId: string, patch: Partial<TimeEntry>) => void;
  addSms: (sms: SmsLog) => void;
  generateDriverToken: (token: DriverToken) => void;
  markTokenUsed: (id: string) => void;
  submitVehicleInspection: (inspection: VehicleInspection) => void;
  /**
   * Stamps `vehicles.lastPretripAt` for the given vehicle. Called as part of
   * the pre-trip lockout flow — once a passing inspection lands the driver
   * gets a 12h window to clock in before another circle-check is required.
   */
  setVehicleLastPretrip: (vehicleId: string, at: string) => void;
  updateClientTicketSettings: (clientId: string, patch: Partial<ClientTicketSettings>) => void;
  recordTicketTransaction: (txn: TicketTransaction) => void;
  recordTicketReplenishment: (rep: TicketReplenishment, invoice: InvoiceData) => void;
  pushNotification: (n: Notification) => void;
  /**
   * Replace the current admin-tunable app settings (GPS tolerance, overtime
   * thresholds, inspection window). Called by api.updateAppSettings after a
   * successful Supabase write.
   */
  setAppSettings: (next: AppSettings) => void;
  /**
   * Admin override for the auto-computed flag on a time entry. Persists both
   * the boolean and a free-form reason so subsequent recomputes don't blow
   * away the admin's decision.
   */
  setTimeEntryFlag: (entryId: string, flagged: boolean, reason: string) => void;
  /**
   * Append a freshly-uploaded ticket photo (driver capture or admin import) to
   * client state so the admin queue picks it up without a refetch.
   */
  addTicketPhoto: (photo: TicketPhoto) => void;
  /**
   * Patch an existing ticket photo — used by the admin manual-entry sheet to
   * record weight/location and flip the row to "entered".
   */
  updateTicketPhoto: (id: string, patch: Partial<TicketPhoto>) => void;
  /**
   * Upsert a client's rate table after an admin save. Replaces the line items
   * wholesale (mirrors the DELETE-then-INSERT done in api.upsertRateTable) and
   * back-fills clients.rateTableId so approveWorkOrder picks the new pricing.
   */
  upsertClientRateTable: (clientId: string, rateTableId: string, lineItems: RateLineItem[]) => void;
  /**
   * Prepend a freshly-recorded service entry. Used by api.addMaintenanceLog
   * after a successful Supabase insert so the mechanic + admin tables refresh
   * without waiting on a refetch.
   */
  addMaintenanceLog: (log: MaintenanceLog) => void;
  /**
   * Prepend a freshly-recorded fuel-up entry. Same shape as
   * addMaintenanceLog — keeps the admin vehicle-detail fuel table live.
   */
  addFuelLog: (log: FuelLog) => void;
  /**
   * Upsert a maintenance work order into local state. Used by the api claim /
   * update / create paths after a successful Supabase write so the mechanic
   * tabs reflect the change without waiting on a realtime tick.
   */
  upsertMaintenanceWorkOrder: (wo: MaintenanceWorkOrder) => void;
};

const DataCtx = createContext<Ctx | null>(null);

const TOKENS_STORAGE_KEY = "fo:driver-tokens:v1";
// Stores { vehicleId: isoTimestamp } for the most recent pre-trip stamp per
// vehicle. We persist this so the lockout flow's "submit inspection → land on
// /driver → bounce to /driver/start-of-day" sequence survives a full-page
// reload (Playwright's page.goto resets React state). The seed file leaves
// lastPretripAt null so the lockout still fires on first visit.
const VEHICLE_PRETRIP_STORAGE_KEY = "fo:vehicle-pretrip:v1";

function readPersistedPretripStamps(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(VEHICLE_PRETRIP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePersistedPretripStamp(vehicleId: string, at: string) {
  if (typeof window === "undefined") return;
  try {
    const current = readPersistedPretripStamps();
    current[vehicleId] = at;
    localStorage.setItem(VEHICLE_PRETRIP_STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* localStorage quota / disabled — silently ignore, the in-memory stamp still works */
  }
}

function readPersistedTokens(): DriverToken[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TOKENS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DriverToken[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePersistedTokens(tokens: DriverToken[]) {
  if (typeof window === "undefined") return;
  try {
    // Only persist tokens NOT in seed data (we don't want to duplicate the seed list)
    const seedTokens = new Set(seed.driverTokens.map((t) => t.token));
    const userGenerated = tokens.filter((t) => !seedTokens.has(t.token));
    localStorage.setItem(TOKENS_STORAGE_KEY, JSON.stringify(userGenerated));
  } catch {
    /* quota or disabled — silent */
  }
}

function mergeTokens(): DriverToken[] {
  const persisted = readPersistedTokens();
  // Seed first (oldest at bottom), then user-generated (newest at top)
  return [...persisted, ...seed.driverTokens];
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>(seed.jobs);
  // No seed for job_logs — drivers create them at runtime. Empty seed is fine
  // because the admin job-detail Sheet just shows "no logs yet" until one lands.
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(seed.workOrders);
  const [invoiceData, setInvoiceData] = useState<InvoiceData[]>(seed.invoiceData);
  const [toolChecklistSubmissions, setToolSubs] = useState<ToolChecklistSubmission[]>(
    seed.toolChecklistSubmissions,
  );
  const [purchaseRequests, setPRs] = useState<PurchaseRequest[]>(seed.purchaseRequests);
  // Inventory is now mutable because the PO approval flow reserves stock by
  // bumping qty_reserved. Seed values back the demo mode; Supabase hydration
  // would replace these once we add inventory_items to fetchAllFromSupabase.
  const [inventoryItems, setInventoryItems] = useState<typeof seed.inventoryItems>(
    seed.inventoryItems,
  );
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>(seed.smsLogs);
  const [driverTokens, setTokens] = useState<DriverToken[]>(seed.driverTokens);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>(seed.timeEntries);
  const [vehicleInspections, setInspections] = useState<VehicleInspection[]>(
    seed.vehicleInspections,
  );
  const [clients, setClients] = useState<Client[]>(seed.clients);
  const [ticketTransactions, setTicketTxns] = useState<TicketTransaction[]>(seed.ticketTransactions);
  const [ticketReplenishments, setTicketReps] = useState<TicketReplenishment[]>(
    seed.ticketReplenishments,
  );
  const [notifications, setNotifications] = useState<Notification[]>(seed.notifications);
  const [ticketPhotos, setTicketPhotos] = useState<TicketPhoto[]>(seed.ticketPhotos);
  // Maintenance + fuel logs: seed for demo mode, Supabase hydration overrides
  // when a session is authed. Both mutator functions prepend new rows so the
  // tables in mechanic.maintenance and admin.vehicles/$id reflect the insert.
  const [maintenanceLogs, setMaintenanceLogs] = useState<MaintenanceLog[]>(seed.maintenanceLogs);
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>(seed.fuelLogs);
  // Mechanic queue. Seeds with a small fixture so the mock-mode mechanic
  // /work-orders surface has at least one queued row to render (the e2e
  // Claim button audit needs a row to act on). Supabase hydration below
  // unconditionally replaces this with the canonical server array.
  const [maintenanceWorkOrders, setMaintenanceWorkOrders] = useState<MaintenanceWorkOrder[]>(
    seed.maintenanceWorkOrders,
  );
  // Rate tables drive the line-item rate lookup in api.approveWorkOrder. Seed
  // values cover the two mock clients (RT-01, RT-02); Supabase hydration
  // overwrites with the live rows when available.
  const [rateTables, setRateTables] = useState<RateTable[]>(seed.rateTables);
  // Vehicles are local state so the pre-trip lockout flow can stamp
  // `lastPretripAt` reactively. Seed values keep null lastPretripAt so the
  // lockout fires on first render until a fresh circle-check is recorded.
  // We also merge in any persisted pretrip stamps (see
  // VEHICLE_PRETRIP_STORAGE_KEY) so a submitted inspection survives a full
  // page reload — without this, the lockout reappears on next navigation
  // because React state is wiped.
  const [vehicles, setVehicles] = useState<Vehicle[]>(() => {
    const stamps = readPersistedPretripStamps();
    if (!Object.keys(stamps).length) return seed.vehicles;
    return seed.vehicles.map((v) =>
      stamps[v.id] ? { ...v, lastPretripAt: stamps[v.id] } : v,
    );
  });
  // App-wide tunables (inspection window, OT thresholds, GPS tolerance).
  // Defaults match the SQL seed; hydrated from public.app_settings below when
  // a Supabase session is available, and writeable via api.updateAppSettings.
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  // Mechanic roster — seeded for mock mode, replaced by the live profiles
  // rows on Supabase hydration so nameForMechanic resolves real UUIDs.
  const [mechanics, setMechanics] = useState<Mechanic[]>(seed.mechanics);

  // Hydrate tokens from localStorage on mount so tokens generated in one tab
  // are visible (and validatable) in any other tab on the same origin.
  useEffect(() => {
    setTokens(mergeTokens());
    function onStorage(e: StorageEvent) {
      if (e.key === TOKENS_STORAGE_KEY) setTokens(mergeTokens());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Supabase hydration: when authed against a real session, replace seed state
  // with whatever the database actually has. Drivers/mechanics/vehicles arrays
  // still come from seed for display purposes (driver auth UUIDs land later).
  const { authed, role } = useAuth();
  useEffect(() => {
    if (!USE_SUPABASE || !authed) return;
    let cancelled = false;
    fetchAllFromSupabase().then((data) => {
      if (cancelled || !data) return;
      setClients(data.clients.length ? data.clients : seed.clients);
      // Hydrate vehicles from Supabase so live GPS + last_pretrip_at land
      // in client state. Fall back to seed if Supabase ever returns empty
      // (which would mean the seed import never ran).
      if (data.vehicles.length) setVehicles(data.vehicles);
      setJobs(data.jobs);
      setJobLogs(data.jobLogs);
      setWorkOrders(data.workOrders);
      setInvoiceData(data.invoiceData);
      setNotifications(data.notifications);
      setTicketTxns(data.ticketTransactions);
      setTicketReps(data.ticketReplenishments);
      // Real ticket-photo rows beat the seed array; an empty server response
      // means "no uploads yet" rather than "fall back to demo data".
      if (data.ticketPhotos) setTicketPhotos(data.ticketPhotos);
      setSmsLogs(data.smsLogs);
      setTimeEntries(data.timeEntries);
      setPRs(data.purchaseRequests);
      if (data.driverTokens.length) setTokens([...data.driverTokens, ...seed.driverTokens]);
      setInspections(data.vehicleInspections);
      setAppSettings(data.appSettings);
      // Empty server array beats the seed — an admin who wipes a client's rate
      // table shouldn't see stale demo rows resurrect on the next page load.
      setRateTables(data.rateTables);
      // Maintenance + fuel: hydrate only when the server returns rows so
      // empty Supabase tables fall back to the demo seed (otherwise the
      // mechanic page would look empty on a fresh install).
      if (data.maintenanceLogs.length) setMaintenanceLogs(data.maintenanceLogs);
      if (data.fuelLogs.length) setFuelLogs(data.fuelLogs);
      // Always replace — an empty server response is the truthful "no queue"
      // state, not a fallback signal. Realtime keeps the array fresh after.
      setMaintenanceWorkOrders(data.maintenanceWorkOrders);
      // Mechanics: only swap to the hydrated array when the server actually
      // returns rows. An empty result on a fresh install would otherwise wipe
      // the seed list and leave every "claimed by X" rendering as a fallback.
      if (data.mechanics.length) setMechanics(data.mechanics);
    });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  // Realtime: single multiplexed channel mirroring backend changes into local
  // state so admin views update without a refetch. Admin-only for sprint 2 —
  // drivers/mechanics keep the optimistic-update flow until we widen RLS.
  useEffect(() => {
    if (!USE_SUPABASE || !supabase || !authed || role !== "admin") return;
    // Capture the narrowed client so the cleanup closure (which runs after
    // the effect body returns) keeps the non-null type — TS doesn't preserve
    // the narrowing through the returned function. Also gives us a single
    // local binding that won't be re-evaluated by React.
    const sb = supabase;

    // Generic upsert-by-id reducer used by every UPDATE/INSERT handler so the
    // ordering is consistent and a new row arriving via realtime doesn't
    // create a duplicate when it's already present from the initial fetch.
    function upsertById<T extends { id: string }>(prev: T[], next: T): T[] {
      return prev.some((x) => x.id === next.id)
        ? prev.map((x) => (x.id === next.id ? next : x))
        : [next, ...prev];
    }
    function removeById<T extends { id: string }>(prev: T[], id: string): T[] {
      return prev.filter((x) => x.id !== id);
    }

    const channel = sb
      .channel("yardward-pro:admin-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setJobs((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbJobToDomain(payload.new as Row<"jobs">);
          setJobs((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_orders" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setWorkOrders((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbWorkOrderToDomain(payload.new as Row<"work_orders">);
          setWorkOrders((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setNotifications((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbNotificationToDomain(payload.new as Row<"notifications">);
          setNotifications((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ticket_photos" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setTicketPhotos((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbTicketPhotoToDomain(payload.new as Row<"ticket_photos">);
          setTicketPhotos((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "time_entries" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setTimeEntries((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbTimeEntryToDomain(payload.new as Row<"time_entries">);
          setTimeEntries((prev) => upsertById(prev, next));
        },
      )
      // Vehicles: the trg_vehicles_set_last_pretrip trigger stamps
      // last_pretrip_at after every passing inspection. Without this
      // subscription the lockout banner stays stale until manual reload.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "vehicles" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setVehicles((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbVehicleToDomain(payload.new as Row<"vehicles">);
          setVehicles((prev) => upsertById(prev, next));
        },
      )
      // Mechanic queue: also subscribed on the admin channel so the admin
      // maintenance dashboard reflects fresh claims/completions. Mechanics
      // get the same updates via their own channel below.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "maintenance_work_orders" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id)
              setMaintenanceWorkOrders((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbMaintenanceWorkOrderToDomain(
            payload.new as Row<"maintenance_work_orders">,
          );
          setMaintenanceWorkOrders((prev) => upsertById(prev, next));
        },
      )
      .subscribe();

    return () => {
      void sb.removeChannel(channel);
    };
  }, [authed, role]);

  // Mechanic-side realtime: the admin channel above only mounts for role==='admin',
  // but mechanics also need live updates so a queued WO claimed by a peer
  // disables the Claim button on this device without a refetch. Single-table
  // subscription scoped to maintenance_work_orders keeps the surface area tight.
  useEffect(() => {
    if (!USE_SUPABASE || !supabase || !authed || role !== "mechanic") return;
    const sb = supabase;
    function upsertById<T extends { id: string }>(prev: T[], next: T): T[] {
      return prev.some((x) => x.id === next.id)
        ? prev.map((x) => (x.id === next.id ? next : x))
        : [next, ...prev];
    }
    function removeById<T extends { id: string }>(prev: T[], id: string): T[] {
      return prev.filter((x) => x.id !== id);
    }
    const channel = sb
      .channel("yardward-pro:mechanic-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "maintenance_work_orders" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id)
              setMaintenanceWorkOrders((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbMaintenanceWorkOrderToDomain(
            payload.new as Row<"maintenance_work_orders">,
          );
          setMaintenanceWorkOrders((prev) => upsertById(prev, next));
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [authed, role]);

  const createJob = useCallback((job: Job) => setJobs((j) => [job, ...j]), []);
  const updateJob = useCallback(
    (id: string, patch: Partial<Job>) =>
      setJobs((j) => j.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [],
  );
  const submitJobLog = useCallback((log: JobLog) => setJobLogs((arr) => [log, ...arr]), []);
  const submitWorkOrder = useCallback((wo: WorkOrder) => setWorkOrders((w) => [wo, ...w]), []);
  const approveWorkOrder = useCallback((id: string, approverId: string, invoice: InvoiceData) => {
    setWorkOrders((w) =>
      w.map((x) =>
        x.id === id
          ? {
              ...x,
              status: "approved",
              approvedBy: approverId,
              approvedAt: new Date().toISOString(),
              invoiceDataId: invoice.id,
            }
          : x,
      ),
    );
    setInvoiceData((inv) => [invoice, ...inv]);
  }, []);
  const rejectWorkOrder = useCallback(
    (id: string, reason: string) =>
      setWorkOrders((w) =>
        w.map((x) =>
          x.id === id
            ? {
                ...x,
                status: "rejected",
                siteIssuesNote: reason || x.siteIssuesNote,
                approvedAt: new Date().toISOString(),
              }
            : x,
        ),
      ),
    [],
  );
  const submitToolChecklist = useCallback(
    (s: ToolChecklistSubmission) => setToolSubs((arr) => [s, ...arr]),
    [],
  );
  const submitStartOfDay = useCallback(
    (entry: TimeEntry) => setTimeEntries((arr) => [entry, ...arr]),
    [],
  );
  const submitEndOfDay = useCallback(
    (entryId: string, patch: Partial<TimeEntry>) =>
      setTimeEntries((arr) => arr.map((x) => (x.id === entryId ? { ...x, ...patch } : x))),
    [],
  );
  const submitPurchaseRequest = useCallback(
    (req: PurchaseRequest) => setPRs((arr) => [req, ...arr]),
    [],
  );
  const approvePurchaseRequest = useCallback(
    (id: string, approverId: string, inventory: { itemId: string; qty: number } | null) =>
      setPRs((arr) =>
        arr.map((x) =>
          x.id === id
            ? {
                ...x,
                status: "approved",
                approvedBy: approverId,
                // 0 when the lookup found no usable stock; 1 when we reserved
                // a unit. Either way we stamp it so the review sheet can tell
                // "approved & reserved" apart from "approved, needs ordering".
                inventoryDecrementQty: inventory?.qty ?? 0,
              }
            : x,
        ),
      ),
    [],
  );
  const markPurchaseRequestOrdered = useCallback(
    (id: string, ordererId: string, supplierOrderRef: string) =>
      setPRs((arr) =>
        arr.map((x) =>
          x.id === id
            ? {
                ...x,
                status: "ordered",
                orderedAt: new Date().toISOString(),
                orderedBy: ordererId,
                supplierOrderRef,
              }
            : x,
        ),
      ),
    [],
  );
  const adjustInventoryReservation = useCallback(
    (inventoryItemId: string, qtyDelta: number) =>
      setInventoryItems((arr) =>
        arr.map((it) =>
          it.id === inventoryItemId
            ? { ...it, qtyReserved: it.qtyReserved + qtyDelta }
            : it,
        ),
      ),
    [],
  );
  const clockIn = useCallback((entry: TimeEntry) => setTimeEntries((arr) => [entry, ...arr]), []);
  const clockOut = useCallback(
    (entryId: string, patch: Partial<TimeEntry>) =>
      setTimeEntries((arr) => arr.map((x) => (x.id === entryId ? { ...x, ...patch } : x))),
    [],
  );
  const addSms = useCallback((sms: SmsLog) => setSmsLogs((arr) => [sms, ...arr]), []);
  const generateDriverToken = useCallback((token: DriverToken) => {
    setTokens((arr) => {
      const next = [token, ...arr];
      writePersistedTokens(next);
      return next;
    });
  }, []);
  const markTokenUsed = useCallback((id: string) => {
    setTokens((arr) => {
      const next = arr.map((x) =>
        x.id === id ? { ...x, usedAt: new Date().toISOString() } : x,
      );
      writePersistedTokens(next);
      return next;
    });
  }, []);
  const submitVehicleInspection = useCallback(
    (inspection: VehicleInspection) => setInspections((arr) => [inspection, ...arr]),
    [],
  );
  const setVehicleLastPretrip = useCallback(
    (vehicleId: string, at: string) => {
      // Persist before the React state update so a quick page reload (e.g.
      // Playwright's page.goto right after a navigate) still sees the stamp.
      writePersistedPretripStamp(vehicleId, at);
      setVehicles((arr) => arr.map((v) => (v.id === vehicleId ? { ...v, lastPretripAt: at } : v)));
    },
    [],
  );
  const updateClientTicketSettings = useCallback(
    (clientId: string, patch: Partial<ClientTicketSettings>) =>
      setClients((arr) =>
        arr.map((c) => (c.id === clientId ? { ...c, tickets: { ...c.tickets, ...patch } } : c)),
      ),
    [],
  );
  const recordTicketTransaction = useCallback(
    (txn: TicketTransaction) => setTicketTxns((arr) => [txn, ...arr]),
    [],
  );
  const recordTicketReplenishment = useCallback(
    (rep: TicketReplenishment, invoice: InvoiceData) => {
      setTicketReps((arr) => [rep, ...arr]);
      setInvoiceData((arr) => [invoice, ...arr]);
    },
    [],
  );
  const pushNotification = useCallback(
    (n: Notification) =>
      setNotifications((arr) => {
        // Idempotent — skip if a notification with this id already exists.
        // Prevents duplicates from the overtime-alert dedup path when the
        // localStorage map is cleared (private browsing, quota) or when
        // two admin sessions fire the same alert concurrently.
        if (arr.some((existing) => existing.id === n.id)) return arr;
        return [n, ...arr];
      }),
    [],
  );
  const setTimeEntryFlag = useCallback(
    (entryId: string, flagged: boolean, reason: string) =>
      setTimeEntries((arr) =>
        arr.map((x) => (x.id === entryId ? { ...x, flagged, flagReason: reason } : x)),
      ),
    [],
  );
  const addTicketPhoto = useCallback(
    (photo: TicketPhoto) =>
      // Idempotent insert — a driver tapping submit twice in flaky cell
      // coverage shouldn't double-queue the same upload on the admin side.
      setTicketPhotos((arr) =>
        arr.some((p) => p.id === photo.id) ? arr : [photo, ...arr],
      ),
    [],
  );
  const updateTicketPhoto = useCallback(
    (id: string, patch: Partial<TicketPhoto>) =>
      setTicketPhotos((arr) => arr.map((p) => (p.id === id ? { ...p, ...patch } : p))),
    [],
  );
  const addMaintenanceLog = useCallback(
    (log: MaintenanceLog) => setMaintenanceLogs((arr) => [log, ...arr]),
    [],
  );
  const addFuelLog = useCallback(
    (log: FuelLog) => setFuelLogs((arr) => [log, ...arr]),
    [],
  );
  const upsertMaintenanceWorkOrder = useCallback(
    (wo: MaintenanceWorkOrder) =>
      setMaintenanceWorkOrders((arr) =>
        arr.some((x) => x.id === wo.id)
          ? arr.map((x) => (x.id === wo.id ? wo : x))
          : [wo, ...arr],
      ),
    [],
  );
  const upsertClientRateTable = useCallback(
    (clientId: string, rateTableId: string, lineItems: RateLineItem[]) => {
      // Wholesale replace the rate table (matches the DELETE/INSERT done on
      // the server side) and back-fill clients.rateTableId so the next work
      // order approval picks the new pricing.
      setRateTables((arr) => {
        const next: RateTable = { id: rateTableId, clientId, lineItems };
        const idx = arr.findIndex((rt) => rt.id === rateTableId);
        if (idx === -1) return [...arr, next];
        const copy = arr.slice();
        copy[idx] = next;
        return copy;
      });
      setClients((arr) =>
        arr.map((c) => (c.id === clientId ? { ...c, rateTableId } : c)),
      );
    },
    [],
  );

  return (
    <DataCtx.Provider
      value={{
        drivers: seed.drivers,
        mechanics,
        vehicles,
        clients,
        appSettings,
        rateTables,
        jobs,
        jobLogs,
        workOrders,
        invoiceData,
        maintenanceLogs,
        fuelLogs,
        maintenanceWorkOrders,
        tools: seed.tools,
        toolChecklistSubmissions,
        purchaseRequests,
        inventoryItems,
        adjustInventoryReservation,
        smsLogs,
        notifications,
        driverTokens,
        ticketPhotos,
        tenders: seed.tenders,
        timeEntries,
        vehicleInspections,
        ticketTransactions,
        ticketReplenishments,
        createJob,
        updateJob,
        submitJobLog,
        submitWorkOrder,
        approveWorkOrder,
        rejectWorkOrder,
        submitToolChecklist,
        submitStartOfDay,
        submitEndOfDay,
        submitPurchaseRequest,
        approvePurchaseRequest,
        markPurchaseRequestOrdered,
        clockIn,
        clockOut,
        addSms,
        generateDriverToken,
        markTokenUsed,
        submitVehicleInspection,
        setVehicleLastPretrip,
        updateClientTicketSettings,
        recordTicketTransaction,
        recordTicketReplenishment,
        pushNotification,
        setAppSettings,
        setTimeEntryFlag,
        addTicketPhoto,
        updateTicketPhoto,
        upsertClientRateTable,
        addMaintenanceLog,
        addFuelLog,
        upsertMaintenanceWorkOrder,
      }}
    >
      {children}
    </DataCtx.Provider>
  );
}

export function useData() {
  const c = useContext(DataCtx);
  if (!c) throw new Error("useData must be within DataProvider");
  return c;
}

let _store: Ctx | null = null;
export function DataBridge() {
  const c = useContext(DataCtx);
  _store = c;
  return null;
}
export function getStore(): Ctx {
  if (!_store) throw new Error("DataBridge not mounted");
  return _store;
}

export type { TokenScope };
