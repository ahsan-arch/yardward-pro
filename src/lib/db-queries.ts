// =============================================================================
// Supabase read helpers used by DataContext on mount.
//
// Each function returns domain-typed data; mapping happens in db-mappers.ts.
// Fetches run in parallel. Tables we haven't migrated to Supabase yet stay
// on seed (see DataContext for the merge).
// =============================================================================
import { supabase } from "./supabase";
import {
  dbClientToDomain,
  dbVehicleToDomain,
  dbJobToDomain,
  dbJobLogToDomain,
  dbWorkOrderToDomain,
  dbInvoiceToDomain,
  dbNotificationToDomain,
  dbTicketTxnToDomain,
  dbTicketRepToDomain,
  dbSmsToDomain,
  dbTimeEntryToDomain,
  dbPurchaseRequestToDomain,
  dbDriverTokenToDomain,
  dbInspectionToDomain,
  dbAppSettingsToDomain,
  dbRateTableToDomain,
  dbMaintenanceLogToDomain,
  dbFuelLogToDomain,
  dbTicketPhotoToDomain,
  dbMaintenanceWorkOrderToDomain,
  dbProfileToMechanic,
} from "./db-mappers";
import type {
  Client,
  Vehicle,
  Job,
  JobLog,
  WorkOrder,
  InvoiceData,
  Notification,
  TicketTransaction,
  TicketReplenishment,
  TicketPhoto,
  SmsLog,
  TimeEntry,
  PurchaseRequest,
  DriverToken,
  VehicleInspection,
  AppSettings,
  RateTable,
  MaintenanceLog,
  FuelLog,
  MaintenanceWorkOrder,
  Mechanic,
} from "@/types/domain";
import { DEFAULT_APP_SETTINGS } from "@/types/domain";

export type HydratedData = {
  clients: Client[];
  vehicles: Vehicle[];
  jobs: Job[];
  jobLogs: JobLog[];
  workOrders: WorkOrder[];
  invoiceData: InvoiceData[];
  notifications: Notification[];
  ticketTransactions: TicketTransaction[];
  ticketReplenishments: TicketReplenishment[];
  ticketPhotos: TicketPhoto[];
  smsLogs: SmsLog[];
  timeEntries: TimeEntry[];
  purchaseRequests: PurchaseRequest[];
  driverTokens: DriverToken[];
  vehicleInspections: VehicleInspection[];
  maintenanceLogs: MaintenanceLog[];
  fuelLogs: FuelLog[];
  maintenanceWorkOrders: MaintenanceWorkOrder[];
  appSettings: AppSettings;
  rateTables: RateTable[];
  mechanics: Mechanic[];
};

// Standalone fetch for app_settings — used both during hydration and on demand
// from the System settings tab when the admin saves changes elsewhere.
export async function fetchAppSettings(): Promise<AppSettings> {
  if (!supabase) return DEFAULT_APP_SETTINGS;
  const { data, error } = await supabase
    .from("app_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();
  if (error || !data) return DEFAULT_APP_SETTINGS;
  return dbAppSettingsToDomain(data);
}

export async function fetchAllFromSupabase(): Promise<HydratedData | null> {
  if (!supabase) return null;

  const [
    clients,
    vehicles,
    jobs,
    jobLogs,
    workOrders,
    invoices,
    invoiceLineItems,
    notifications,
    ticketTxns,
    ticketReps,
    ticketPhotos,
    smsLogs,
    timeEntries,
    purchaseRequests,
    driverTokens,
    inspections,
    inspectionItems,
    maintenanceLogs,
    fuelLogs,
    maintenanceWorkOrders,
    appSettings,
    rateTables,
    rateLineItems,
    mechanicProfiles,
  ] = await Promise.all([
    supabase.from("clients").select("*"),
    supabase.from("vehicles").select("*"),
    supabase.from("jobs").select("*"),
    supabase.from("job_logs").select("*").order("logged_at", { ascending: false }),
    supabase.from("work_orders").select("*"),
    supabase.from("invoice_data").select("*"),
    supabase.from("invoice_line_items").select("*"),
    supabase.from("notifications").select("*").order("created_at", { ascending: false }),
    supabase.from("ticket_transactions").select("*").order("occurred_at", { ascending: false }),
    supabase.from("ticket_replenishments").select("*").order("triggered_at", { ascending: false }),
    supabase.from("ticket_photos").select("*").order("uploaded_at", { ascending: false }),
    supabase.from("sms_logs").select("*").order("sent_at", { ascending: false }),
    supabase.from("time_entries").select("*"),
    supabase.from("purchase_requests").select("*"),
    supabase.from("driver_tokens").select("*"),
    supabase.from("vehicle_inspections").select("*"),
    supabase.from("inspection_items").select("*"),
    supabase.from("maintenance_logs").select("*").order("date", { ascending: false }),
    supabase.from("fuel_logs").select("*").order("date", { ascending: false }),
    // Mechanic queue. Order so 'queued' rows surface first, then by priority
    // hint (lex order works here because the priority CHECK constraint values
    // happen to sort the wrong direction — see the route-level sort which
    // weights critical>high>medium>low. The fetch order is only a tie-break).
    supabase
      .from("maintenance_work_orders")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("app_settings").select("*").eq("id", "default").maybeSingle(),
    supabase.from("rate_tables").select("*"),
    supabase.from("rate_line_items").select("*"),
    // Mechanic roster lives in public.profiles alongside admins/drivers.
    // We only need id+name+email+status to back the mechanic-name lookup
    // in mechanic.work-orders.tsx — anything richer (specialty, shop) gets
    // filled in by the seed/blank defaults in the mapper.
    supabase
      .from("profiles")
      .select("id, email, name, phone, role, status, created_at")
      .eq("role", "mechanic"),
  ]);

  type LineItem = NonNullable<typeof invoiceLineItems.data>[number];
  const lineItemsByInvoice = new Map<string, LineItem[]>();
  for (const li of invoiceLineItems.data ?? []) {
    const arr = lineItemsByInvoice.get(li.invoice_data_id) ?? [];
    arr.push(li);
    lineItemsByInvoice.set(li.invoice_data_id, arr);
  }
  type InspectionItem = NonNullable<typeof inspectionItems.data>[number];
  const inspectionItemsByInspection = new Map<string, InspectionItem[]>();
  for (const it of inspectionItems.data ?? []) {
    const arr = inspectionItemsByInspection.get(it.inspection_id) ?? [];
    arr.push(it);
    inspectionItemsByInspection.set(it.inspection_id, arr);
  }
  // Bucket flat rate_line_items rows under their parent rate_table_id so the
  // mapper can build a complete RateTable in a single pass.
  type RateLI = NonNullable<typeof rateLineItems.data>[number];
  const rateLineItemsByTable = new Map<string, RateLI[]>();
  for (const li of rateLineItems.data ?? []) {
    const arr = rateLineItemsByTable.get(li.rate_table_id) ?? [];
    arr.push(li);
    rateLineItemsByTable.set(li.rate_table_id, arr);
  }

  return {
    clients: (clients.data ?? []).map(dbClientToDomain),
    vehicles: (vehicles.data ?? []).map(dbVehicleToDomain),
    jobs: (jobs.data ?? []).map(dbJobToDomain),
    jobLogs: (jobLogs.data ?? []).map(dbJobLogToDomain),
    workOrders: (workOrders.data ?? []).map(dbWorkOrderToDomain),
    invoiceData: (invoices.data ?? []).map((inv) =>
      dbInvoiceToDomain(inv, lineItemsByInvoice.get(inv.id) ?? []),
    ),
    notifications: (notifications.data ?? []).map(dbNotificationToDomain),
    ticketTransactions: (ticketTxns.data ?? []).map(dbTicketTxnToDomain),
    ticketReplenishments: (ticketReps.data ?? []).map(dbTicketRepToDomain),
    ticketPhotos: (ticketPhotos.data ?? []).map(dbTicketPhotoToDomain),
    smsLogs: (smsLogs.data ?? []).map(dbSmsToDomain),
    timeEntries: (timeEntries.data ?? []).map(dbTimeEntryToDomain),
    purchaseRequests: (purchaseRequests.data ?? []).map(dbPurchaseRequestToDomain),
    driverTokens: (driverTokens.data ?? []).map(dbDriverTokenToDomain),
    vehicleInspections: (inspections.data ?? []).map((ins) =>
      dbInspectionToDomain(ins, inspectionItemsByInspection.get(ins.id) ?? []),
    ),
    maintenanceLogs: (maintenanceLogs.data ?? []).map(dbMaintenanceLogToDomain),
    fuelLogs: (fuelLogs.data ?? []).map(dbFuelLogToDomain),
    maintenanceWorkOrders: (maintenanceWorkOrders.data ?? []).map(
      dbMaintenanceWorkOrderToDomain,
    ),
    appSettings: appSettings.data
      ? dbAppSettingsToDomain(appSettings.data)
      : DEFAULT_APP_SETTINGS,
    rateTables: (rateTables.data ?? []).map((rt) =>
      dbRateTableToDomain(rt, rateLineItemsByTable.get(rt.id) ?? []),
    ),
    mechanics: (mechanicProfiles.data ?? []).map(dbProfileToMechanic),
  };
}
