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
  dbConversationToDomain,
  dbConversationParticipantToDomain,
  dbMessageToDomain,
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
  Conversation,
  ConversationParticipant,
  Message,
  Admin,
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
  // Real admin profiles, hydrated from public.profiles WHERE role='admin'.
  // Replaces the previous hardcoded "Alex Chen" placeholder in the Users tab.
  admins: Admin[];
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
  // ---- Communications ----
  conversations: Conversation[];
  conversationParticipants: ConversationParticipant[];
  messages: Message[];
  upsertConversation: (c: Conversation) => void;
  upsertParticipant: (p: ConversationParticipant) => void;
  upsertMessage: (m: Message) => void;
  // Updates the cached `phone` on a driver or mechanic locally. Called from
  // the admin/drivers Sheet after api.updateUserPhone succeeds so the UI
  // reflects the new number without waiting for a refetch.
  setUserPhone: (userId: string, phone: string) => void;
  notifications: Notification[];
  driverTokens: DriverToken[];
  ticketPhotos: TicketPhoto[];
  tenders: typeof seed.tenders;
  timeEntries: TimeEntry[];
  vehicleInspections: VehicleInspection[];
  ticketTransactions: TicketTransaction[];
  ticketReplenishments: TicketReplenishment[];
  createClient: (client: Client) => void;
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
   * Stamp `readAt` on every still-unread notification belonging to `userId`.
   * Called optimistically when the user opens NotificationsBell so the badge
   * clears immediately and individual rows lose their unread treatment;
   * api.markAllNotificationsRead persists the same UPDATE to Supabase.
   */
  markAllNotificationsRead: (userId: string, readAt: string) => void;
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
  /**
   * Upsert a vehicle into local state. Used by api.createVehicle after a
   * successful insert so the admin vehicles grid reflects the new row without
   * waiting on the realtime tick.
   */
  upsertVehicle: (v: Vehicle) => void;
};

const DataCtx = createContext<Ctx | null>(null);

const TOKENS_STORAGE_KEY = "fo:driver-tokens:v1";
// Stores { vehicleId: isoTimestamp } for the most recent pre-trip stamp per
// vehicle. We persist this so the lockout flow's "submit inspection → land on
// /driver → bounce to /driver/start-of-day" sequence survives a full-page
// reload (Playwright's page.goto resets React state). The seed file leaves
// lastPretripAt null so the lockout still fires on first visit.
const VEHICLE_PRETRIP_STORAGE_KEY = "fo:vehicle-pretrip:v1";
// Opt-in sessionStorage flag the e2e suite sets via page.addInitScript when it
// needs the seed to ship with an OPEN shift for D-01 (no clockOut, no recent
// end_of_shift checklist) so the end-of-day gate banner renders without
// depending on UI-mediated clock-in state surviving a full page reload. We
// gate this behind a flag so the other EOD tests (which assert "no open
// shift => gate hidden / submit enabled") keep their seed assumptions.
const TEST_OPEN_SHIFT_FLAG = "fo:test-open-shift-d01";

function readTestOpenShiftFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(TEST_OPEN_SHIFT_FLAG) === "1";
  } catch {
    return false;
  }
}

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
  // In Supabase mode we only surface the persisted (user-generated) tokens
  // until hydration arrives with the real database rows. Mock mode keeps the
  // seed tokens so the demo tokens UI is populated.
  if (USE_SUPABASE) return persisted;
  // Seed first (oldest at bottom), then user-generated (newest at top)
  return [...persisted, ...seed.driverTokens];
}

export function DataProvider({ children }: { children: ReactNode }) {
  // Empty initial state when Supabase is configured — the hydration effect
  // below replaces these with the live rows. Mock mode (tests + dev without
  // env vars) keeps the seed values so the UI is populated immediately.
  const initEmpty = USE_SUPABASE;
  const [jobs, setJobs] = useState<Job[]>(initEmpty ? [] : seed.jobs);
  // No seed for job_logs — drivers create them at runtime. Empty seed is fine
  // because the admin job-detail Sheet just shows "no logs yet" until one lands.
  const [jobLogs, setJobLogs] = useState<JobLog[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(initEmpty ? [] : seed.workOrders);
  const [invoiceData, setInvoiceData] = useState<InvoiceData[]>(initEmpty ? [] : seed.invoiceData);
  const [toolChecklistSubmissions, setToolSubs] = useState<ToolChecklistSubmission[]>(
    initEmpty ? [] : seed.toolChecklistSubmissions,
  );
  const [purchaseRequests, setPRs] = useState<PurchaseRequest[]>(initEmpty ? [] : seed.purchaseRequests);
  // Inventory is now mutable because the PO approval flow reserves stock by
  // bumping qty_reserved. Seed values back the demo mode; Supabase hydration
  // would replace these once we add inventory_items to fetchAllFromSupabase.
  const [inventoryItems, setInventoryItems] = useState<typeof seed.inventoryItems>(
    seed.inventoryItems,
  );
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>(initEmpty ? [] : seed.smsLogs);
  // Communications. Empty seed — no mock fixtures because the feature is
  // strictly Supabase-backed; mock-mode developers see an empty inbox.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationParticipants, setConversationParticipants] = useState<
    ConversationParticipant[]
  >([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [driverTokens, setTokens] = useState<DriverToken[]>(initEmpty ? [] : seed.driverTokens);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>(() => {
    // E2E opt-in: when the test sets the open-shift flag, prepend a synthetic
    // OPEN time entry for D-01 so the EOD-gate test sees an active shift after
    // page.goto wipes React state. Stamped 1h ago so "hours so far" renders a
    // positive number, and intentionally has NO matching end_of_shift tool
    // checklist submission so the gate banner fires.
    if (readTestOpenShiftFlag()) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const synthetic: TimeEntry = {
        id: "TE-TEST-OPEN-D01",
        driverId: "D-01",
        clockIn: oneHourAgo,
        clockOut: null,
        gpsClockIn: { lat: 43.66, lng: -79.41 },
        gpsClockOut: null,
        vehicleMovementCorrelation: "pending",
        flagged: false,
        flagReason: "",
        pretripInspectionId: null,
      };
      return [synthetic, ...seed.timeEntries];
    }
    return initEmpty ? [] : seed.timeEntries;
  });
  const [vehicleInspections, setInspections] = useState<VehicleInspection[]>(
    initEmpty ? [] : seed.vehicleInspections,
  );
  const [clients, setClients] = useState<Client[]>(initEmpty ? [] : seed.clients);
  const [ticketTransactions, setTicketTxns] = useState<TicketTransaction[]>(
    initEmpty ? [] : seed.ticketTransactions,
  );
  const [ticketReplenishments, setTicketReps] = useState<TicketReplenishment[]>(
    initEmpty ? [] : seed.ticketReplenishments,
  );
  const [notifications, setNotifications] = useState<Notification[]>(
    initEmpty ? [] : seed.notifications,
  );
  const [ticketPhotos, setTicketPhotos] = useState<TicketPhoto[]>(
    initEmpty ? [] : seed.ticketPhotos,
  );
  const [maintenanceLogs, setMaintenanceLogs] = useState<MaintenanceLog[]>(
    initEmpty ? [] : seed.maintenanceLogs,
  );
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>(initEmpty ? [] : seed.fuelLogs);
  const [maintenanceWorkOrders, setMaintenanceWorkOrders] = useState<MaintenanceWorkOrder[]>(
    initEmpty ? [] : seed.maintenanceWorkOrders,
  );
  const [rateTables, setRateTables] = useState<RateTable[]>(initEmpty ? [] : seed.rateTables);
  // Drivers/tools/tenders: previously bound directly to seed in the provider
  // value (never hydrated). Now in state + fetched from Supabase like the rest.
  const [drivers, setDrivers] = useState<typeof seed.drivers>(initEmpty ? [] : seed.drivers);
  const [tools, setTools] = useState<typeof seed.tools>(initEmpty ? [] : seed.tools);
  const [tenders, setTenders] = useState<typeof seed.tenders>(initEmpty ? [] : seed.tenders);
  // Vehicles are local state so the pre-trip lockout flow can stamp
  // `lastPretripAt` reactively. Seed values keep null lastPretripAt so the
  // lockout fires on first render until a fresh circle-check is recorded.
  // We also merge in any persisted pretrip stamps (see
  // VEHICLE_PRETRIP_STORAGE_KEY) so a submitted inspection survives a full
  // page reload — without this, the lockout reappears on next navigation
  // because React state is wiped.
  const [vehicles, setVehicles] = useState<Vehicle[]>(() => {
    // In Supabase mode, start with [] — the hydration effect fetches the live
    // vehicles and overlays the persisted pretrip stamps after.
    if (USE_SUPABASE) return [];
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
  const [mechanics, setMechanics] = useState<Mechanic[]>(initEmpty ? [] : seed.mechanics);
  const [admins, setAdmins] = useState<Admin[]>([]);

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

  // Supabase hydration: when authed against a real session, replace local
  // state with whatever the database actually has. ALL tables go through the
  // hydrated values — no `: seed.X` fallback. An empty server array is the
  // truthful "nothing here yet" state, not a signal to fall back to demo data.
  const { authed, role } = useAuth();
  useEffect(() => {
    if (!USE_SUPABASE || !authed) return;
    let cancelled = false;
    fetchAllFromSupabase().then((data) => {
      if (cancelled || !data) return;
      setClients(data.clients);
      // Vehicles: overlay any persisted pretrip stamps so a recently-submitted
      // inspection survives a page reload. The Supabase row is authoritative
      // for everything except the lockout state (which we persist locally).
      const stamps = readPersistedPretripStamps();
      setVehicles(
        data.vehicles.map((v) =>
          stamps[v.id] ? { ...v, lastPretripAt: stamps[v.id] } : v,
        ),
      );
      setJobs(data.jobs);
      setJobLogs(data.jobLogs);
      setWorkOrders(data.workOrders);
      setInvoiceData(data.invoiceData);
      setNotifications(data.notifications);
      setTicketTxns(data.ticketTransactions);
      setTicketReps(data.ticketReplenishments);
      setTicketPhotos(data.ticketPhotos);
      setSmsLogs(data.smsLogs);
      setTimeEntries(data.timeEntries);
      setPRs(data.purchaseRequests);
      // Driver tokens: merge with any localStorage-persisted tokens (user-
      // generated tokens are stored locally for cross-tab visibility before
      // the server roundtrip). DO NOT merge with seed — those are demo only.
      setTokens([...data.driverTokens, ...readPersistedTokens()]);
      setInspections(data.vehicleInspections);
      setAppSettings(data.appSettings);
      setRateTables(data.rateTables);
      setMaintenanceLogs(data.maintenanceLogs);
      setFuelLogs(data.fuelLogs);
      setMaintenanceWorkOrders(data.maintenanceWorkOrders);
      setMechanics(data.mechanics);
      setDrivers(data.drivers);
      setAdmins(data.admins);
      setTools(data.tools);
      setTenders(data.tenders);
      setConversations(data.conversations);
      setConversationParticipants(data.conversationParticipants);
      setMessages(data.messages);
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
      // Communications: admin observes every conversation + every message
      // server-side via RLS. Local mirror keeps the inbox live without the
      // user having to refresh.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setConversations((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationToDomain(payload.new as Row<"conversations">);
          setConversations((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_participants" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id)
              setConversationParticipants((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationParticipantToDomain(
            payload.new as Row<"conversation_participants">,
          );
          setConversationParticipants((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setMessages((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbMessageToDomain(payload.new as Row<"messages">);
          setMessages((prev) => upsertById(prev, next));
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
      // Communications subscriptions for mechanic. RLS filters to their own
      // conversations so the channel only delivers what they're allowed to see.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setConversations((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationToDomain(payload.new as Row<"conversations">);
          setConversations((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_participants" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id)
              setConversationParticipants((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationParticipantToDomain(
            payload.new as Row<"conversation_participants">,
          );
          setConversationParticipants((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setMessages((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbMessageToDomain(payload.new as Row<"messages">);
          setMessages((prev) => upsertById(prev, next));
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [authed, role]);

  // Driver-side realtime. Previously drivers had no channel because their
  // DataContext was read-only for the data they care about; the Communications
  // feature is the first driver-mutable cross-cutting surface, so a dedicated
  // channel keeps subscription noise off the admin/mechanic channels.
  useEffect(() => {
    if (!USE_SUPABASE || !supabase || !authed || role !== "driver") return;
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
      .channel("yardward-pro:driver-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setConversations((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationToDomain(payload.new as Row<"conversations">);
          setConversations((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_participants" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id)
              setConversationParticipants((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbConversationParticipantToDomain(
            payload.new as Row<"conversation_participants">,
          );
          setConversationParticipants((prev) => upsertById(prev, next));
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as { id?: string };
            if (oldRow.id) setMessages((prev) => removeById(prev, oldRow.id!));
            return;
          }
          const next = dbMessageToDomain(payload.new as Row<"messages">);
          setMessages((prev) => upsertById(prev, next));
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [authed, role]);

  const createClient = useCallback(
    (client: Client) => setClients((arr) => [client, ...arr]),
    [],
  );
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

  // Communications mutators. Standard upsert-by-id semantics so optimistic
  // local updates from api.ts and realtime echoes converge to the same state.
  const upsertConversation = useCallback((c: Conversation) => {
    setConversations((prev) =>
      prev.some((x) => x.id === c.id)
        ? prev.map((x) => (x.id === c.id ? c : x))
        : [c, ...prev],
    );
  }, []);
  const upsertParticipant = useCallback((p: ConversationParticipant) => {
    setConversationParticipants((prev) =>
      prev.some((x) => x.id === p.id)
        ? prev.map((x) => (x.id === p.id ? p : x))
        : [p, ...prev],
    );
  }, []);
  const upsertMessage = useCallback((m: Message) => {
    setMessages((prev) =>
      prev.some((x) => x.id === m.id)
        ? prev.map((x) => (x.id === m.id ? m : x))
        : [m, ...prev],
    );
  }, []);
  const setUserPhone = useCallback((userId: string, phone: string) => {
    setDrivers((prev) =>
      prev.map((d) => (d.id === userId ? { ...d, phone } : d)),
    );
    setMechanics((prev) =>
      prev.map((m) => (m.id === userId ? { ...m, phone } : m)),
    );
  }, []);
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
  const markAllNotificationsRead = useCallback(
    (userId: string, readAt: string) =>
      setNotifications((arr) =>
        arr.map((n) =>
          n.userId === userId && !n.readAt ? { ...n, readAt } : n,
        ),
      ),
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
  const upsertVehicle = useCallback(
    (v: Vehicle) =>
      setVehicles((arr) =>
        arr.some((x) => x.id === v.id)
          ? arr.map((x) => (x.id === v.id ? v : x))
          : [v, ...arr],
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
        drivers,
        mechanics,
        admins,
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
        tools,
        toolChecklistSubmissions,
        purchaseRequests,
        inventoryItems,
        adjustInventoryReservation,
        smsLogs,
        conversations,
        conversationParticipants,
        messages,
        upsertConversation,
        setUserPhone,
        upsertParticipant,
        upsertMessage,
        notifications,
        driverTokens,
        ticketPhotos,
        tenders,
        timeEntries,
        vehicleInspections,
        ticketTransactions,
        ticketReplenishments,
        createClient,
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
        markAllNotificationsRead,
        setAppSettings,
        setTimeEntryFlag,
        addTicketPhoto,
        updateTicketPhoto,
        upsertClientRateTable,
        addMaintenanceLog,
        addFuelLog,
        upsertMaintenanceWorkOrder,
        upsertVehicle,
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
  // E2E hook: lets tests bump a maintenance work order's updatedAt so the
  // mechanic sheet's realtime-sync effect fires the "row updated externally"
  // banner. Mock mode has no second tab/Supabase realtime to drive this for
  // real, so the button-audit Discard test reaches in here directly. Guarded
  // by `typeof window` for SSR safety and only attaches when a store is
  // available so we don't ship a half-wired hook in production builds.
  useEffect(() => {
    if (typeof window === "undefined" || !c) return;
    const w = window as unknown as {
      __simulateMwoExternalUpdate?: (id: string) => boolean;
    };
    w.__simulateMwoExternalUpdate = (id: string) => {
      const existing = c.maintenanceWorkOrders.find((m) => m.id === id);
      if (!existing) return false;
      c.upsertMaintenanceWorkOrder({
        ...existing,
        updatedAt: new Date().toISOString(),
      });
      return true;
    };
    return () => {
      delete w.__simulateMwoExternalUpdate;
    };
  }, [c]);
  return null;
}
export function getStore(): Ctx {
  if (!_store) throw new Error("DataBridge not mounted");
  return _store;
}

export type { TokenScope };
