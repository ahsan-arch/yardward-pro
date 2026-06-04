// =============================================================================
// Snake_case Postgres rows <-> camelCase domain types.
// Used by DataContext on read and by api.ts mutations on write.
// =============================================================================
import type { Row, Insert } from "./supabase";
import type {
  Client,
  Vehicle,
  Job,
  JobLog,
  WorkOrder,
  InvoiceData,
  TimeEntry,
  PurchaseRequest,
  InventoryCheckSnapshot,
  SmsLog,
  Notification,
  DriverToken,
  VehicleInspection,
  TicketTransaction,
  TicketReplenishment,
  TicketPhoto,
  InspectionItem,
  GeotabSnapshot,
  AppSettings,
  RateTable,
  RateLineItem,
  MaintenanceLog,
  FuelLog,
  MaintenanceWorkOrder,
  MaintenanceWorkOrderPart,
  MaintenanceWorkOrderPriority,
  MaintenanceWorkOrderStatus,
  MaintenanceWorkOrderSource,
  Mechanic,
  Driver,
  Tool,
  ToolCondition,
  Tender,
} from "@/types/domain";

// ---------- app settings (singleton) ----------
export function dbAppSettingsToDomain(r: Row<"app_settings">): AppSettings {
  return {
    gpsToleranceMinutes: r.gps_tolerance_minutes,
    overtimeWarningHours: Number(r.overtime_warning_hours),
    overtimeAlertHours: Number(r.overtime_alert_hours),
    inspectionMinDurationSeconds: r.inspection_min_duration_seconds,
    inspectionMaxDurationSeconds: r.inspection_max_duration_seconds,
    updatedAt: r.updated_at,
  };
}

// ---------- profiles -> mechanics ----------
// public.profiles is the unified user table (admins, drivers, mechanics). We
// hydrate the mechanic subset here; drivers are still backed by seed for now
// since the driver auth UUID mapping hasn't landed. The Mechanic domain type
// carries specialty + shopId which don't exist on the profiles row — keep
// them empty/null-equivalent so the UI can still render until those columns
// (or a side table) are added.
export function dbProfileToMechanic(r: Row<"profiles">): Mechanic {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: "mechanic",
    phone: r.phone,
    status: r.status,
    createdAt: r.created_at,
    specialty: "",
    shopId: "",
  };
}

// ---------- drivers ----------
// drivers extends User. The User-side fields (name/email/phone/status) live on
// public.profiles (linked via shared UUID); the driver-specific fields live on
// public.drivers. Caller passes both rows so the mapper can compose a full
// Driver object in one pass.
export function dbDriverToDomain(
  driver: Row<"drivers">,
  profile?: Row<"profiles"> | null,
): Driver {
  return {
    id: driver.id,
    email: profile?.email ?? "",
    name: profile?.name ?? "",
    role: "driver",
    phone: profile?.phone ?? "",
    status: (profile?.status ?? "active") as "active" | "inactive",
    createdAt: profile?.created_at ?? new Date().toISOString(),
    licenseNumber: driver.license_number,
    licenseExpiry: driver.license_expiry,
    vehicleAssignmentId: driver.vehicle_assignment_id,
    currentTokenId: driver.current_token_id,
    initials: driver.initials,
  };
}

// ---------- tools ----------
export function dbToolToDomain(r: Row<"tools">): Tool {
  return {
    id: r.id,
    name: r.name,
    condition: r.condition as ToolCondition,
    vehicleId: r.vehicle_id,
  };
}

// ---------- tenders ----------
export function dbTenderToDomain(r: Row<"tenders">): Tender {
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    url: r.url,
    closingDate: r.closing_date ?? "",
    summary: r.summary ?? "",
    scrapedAt: r.scraped_at,
  };
}

// ---------- clients ----------
export function dbClientToDomain(r: Row<"clients">): Client {
  return {
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    email: r.email,
    phone: r.phone,
    billingAddress: r.billing_address,
    rateTableId: r.rate_table_id,
    notes: r.notes,
    status: r.status as "active" | "inactive",
    tickets: {
      enabled: r.tickets_enabled,
      balance: r.tickets_balance,
      threshold: r.tickets_threshold,
      bundleSize: r.tickets_bundle_size,
      bundlePrice: Number(r.tickets_bundle_price),
      autoBillEnabled: r.tickets_auto_bill_enabled,
      reportFrequency: r.tickets_report_frequency,
      reportRecipients: r.tickets_report_recipients,
    },
  };
}

export function domainClientToDb(c: Client): Insert<"clients"> {
  return {
    id: c.id,
    name: c.name,
    contact_name: c.contactName,
    email: c.email,
    phone: c.phone,
    billing_address: c.billingAddress,
    rate_table_id: c.rateTableId,
    notes: c.notes,
    status: c.status,
    tickets_enabled: c.tickets.enabled,
    tickets_balance: c.tickets.balance,
    tickets_threshold: c.tickets.threshold,
    tickets_bundle_size: c.tickets.bundleSize,
    tickets_bundle_price: c.tickets.bundlePrice,
    tickets_auto_bill_enabled: c.tickets.autoBillEnabled,
    tickets_report_frequency: c.tickets.reportFrequency,
    tickets_report_recipients: c.tickets.reportRecipients,
  };
}

// ---------- vehicles ----------
export function dbVehicleToDomain(r: Row<"vehicles">): Vehicle {
  return {
    id: r.id,
    name: r.name,
    plate: r.plate,
    year: r.year,
    type: r.type,
    vin: r.vin,
    odometer: r.odometer,
    engineHours: r.engine_hours,
    lastService: r.last_service ?? "",
    nextServiceDue: r.next_service_due ?? "",
    driverId: r.driver_id,
    geotabDeviceId: r.geotab_device_id,
    status: r.status,
    // Live telematics columns are written by the Geotab cron.
    latitude: r.latitude,
    longitude: r.longitude,
    speedMph: r.speed_mph,
    speedKmh: r.speed_kmh,
    isDriving: r.is_driving,
    lastSeenAt: r.last_seen_at,
    locationUpdatedAt: r.location_updated_at,
    // Pre-trip lockout: when last_pretrip_at is null OR >12h old, the
    // driver gets blocked at /driver/start-of-day until they submit a
    // passing circle-check. Mapping it here is what lets the lockout
    // see fresh inspections on Supabase reloads.
    lastPretripAt: r.last_pretrip_at,
  };
}

// ---------- jobs ----------
export function dbJobToDomain(r: Row<"jobs">): Job {
  return {
    id: r.id,
    clientId: r.client_id,
    location: {
      address: r.location_address,
      lat: r.location_lat,
      lng: r.location_lng,
    },
    scheduledAt: r.scheduled_at,
    durationMin: r.duration_min,
    driverId: r.driver_id,
    vehicleId: r.vehicle_id,
    status: r.status,
    notes: r.notes,
    createdBy: r.created_by ?? "",
    createdAt: r.created_at,
  };
}

export function domainJobToDb(j: Job): Insert<"jobs"> {
  return {
    id: j.id,
    client_id: j.clientId,
    location_address: j.location.address,
    location_lat: j.location.lat,
    location_lng: j.location.lng,
    scheduled_at: j.scheduledAt,
    duration_min: j.durationMin,
    driver_id: j.driverId,
    vehicle_id: j.vehicleId,
    status: j.status,
    notes: j.notes,
    created_by: j.createdBy || null,
  };
}

// ---------- job logs ----------
// Mid-shift driver notes attached to a job. Separate table from work_orders so
// drivers can drop quick "stuck at gate" updates without filling out the full
// end-of-shift form. Admin job detail Sheet renders these inline.
export function dbJobLogToDomain(r: Row<"job_logs">): JobLog {
  return {
    id: r.id,
    jobId: r.job_id,
    driverId: r.driver_id,
    vehicleId: r.vehicle_id,
    body: r.body,
    gpsLat: r.gps_lat,
    gpsLng: r.gps_lng,
    loggedAt: r.logged_at,
    createdAt: r.created_at,
  };
}

// ---------- work orders ----------
export function dbWorkOrderToDomain(r: Row<"work_orders">): WorkOrder {
  return {
    id: r.id,
    jobId: r.job_id,
    driverId: r.driver_id,
    workPerformed: r.work_performed,
    loadType: r.load_type,
    weightTonnes: Number(r.weight_tonnes),
    dumpSite: r.dump_site,
    gpsCapture:
      r.gps_lat != null && r.gps_lng != null && r.gps_captured_at != null
        ? { lat: r.gps_lat, lng: r.gps_lng, capturedAt: r.gps_captured_at }
        : null,
    foremanSignature: r.foreman_signature,
    siteIssues: r.site_issues,
    siteIssuesNote: r.site_issues_note,
    submittedAt: r.submitted_at,
    status: r.status,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    invoiceDataId: r.invoice_data_id,
  };
}

export function domainWorkOrderToDb(w: WorkOrder): Insert<"work_orders"> {
  return {
    id: w.id,
    job_id: w.jobId,
    driver_id: w.driverId,
    work_performed: w.workPerformed,
    load_type: w.loadType,
    weight_tonnes: w.weightTonnes,
    dump_site: w.dumpSite,
    gps_lat: w.gpsCapture?.lat ?? null,
    gps_lng: w.gpsCapture?.lng ?? null,
    gps_captured_at: w.gpsCapture?.capturedAt ?? null,
    foreman_signature: w.foremanSignature,
    site_issues: w.siteIssues,
    site_issues_note: w.siteIssuesNote,
    status: w.status,
    approved_by: w.approvedBy,
    approved_at: w.approvedAt,
    invoice_data_id: w.invoiceDataId,
  };
}

// ---------- invoice data ----------
export function dbInvoiceToDomain(
  r: Row<"invoice_data">,
  lineItems: Row<"invoice_line_items">[],
): InvoiceData {
  return {
    id: r.id,
    workOrderId: r.work_order_id ?? "",
    clientId: r.client_id,
    kind: r.kind,
    lineItems: lineItems
      .sort((a, b) => a.position - b.position)
      .map((li) => ({
        description: li.description,
        qty: Number(li.qty),
        rate: Number(li.rate),
        amount: Number(li.amount),
      })),
    total: Number(r.total),
    qboSyncStatus: r.qbo_sync_status,
    qboInvoiceId: r.qbo_invoice_id,
  };
}

// ---------- time entries ----------
export function dbTimeEntryToDomain(r: Row<"time_entries">): TimeEntry {
  return {
    id: r.id,
    driverId: r.driver_id,
    clockIn: r.clock_in,
    clockOut: r.clock_out,
    gpsClockIn:
      r.gps_clock_in_lat != null && r.gps_clock_in_lng != null
        ? { lat: r.gps_clock_in_lat, lng: r.gps_clock_in_lng }
        : null,
    gpsClockOut:
      r.gps_clock_out_lat != null && r.gps_clock_out_lng != null
        ? { lat: r.gps_clock_out_lat, lng: r.gps_clock_out_lng }
        : null,
    vehicleMovementCorrelation: r.vehicle_movement_correlation,
    flagged: r.flagged,
    flagReason: r.flag_reason,
    pretripInspectionId: r.pretrip_inspection_id ?? null,
  };
}

// ---------- purchase requests ----------
//
// Defensive JSONB parser for purchase_requests.inventory_check_result. The
// column is jsonb so Supabase returns the parsed structure directly, but we
// still guard against legacy rows (column null), malformed payloads, or
// objects-not-arrays so the admin review sheet never crashes on bad data.
function parseInventoryCheckResult(raw: unknown): InventoryCheckSnapshot[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const out: InventoryCheckSnapshot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.inventoryItemId === "string" &&
      typeof e.name === "string" &&
      typeof e.sku === "string" &&
      typeof e.qtyOnHand === "number" &&
      typeof e.supplierId === "string"
    ) {
      out.push({
        inventoryItemId: e.inventoryItemId,
        name: e.name,
        sku: e.sku,
        qtyOnHand: e.qtyOnHand,
        supplierId: e.supplierId,
      });
    }
  }
  return out;
}

export function dbPurchaseRequestToDomain(r: Row<"purchase_requests">): PurchaseRequest {
  return {
    id: r.id,
    mechanicId: r.mechanic_id,
    item: r.item,
    reason: r.reason,
    estimatedCost: Number(r.estimated_cost),
    urgency: r.urgency,
    inventoryCheckResult: parseInventoryCheckResult(r.inventory_check_result),
    inventoryCheckedAt: r.inventory_checked_at,
    status: r.status,
    approvedBy: r.approved_by,
    supplierId: r.supplier_id,
    createdAt: r.created_at,
    // Approval-time inventory reservation + supplier-order bookkeeping. All
    // four are nullable in the DB (legacy rows from sprint 1 don't have the
    // values) so we pass them through verbatim instead of coercing to 0/"".
    inventoryDecrementQty: r.inventory_decrement_qty,
    orderedAt: r.ordered_at,
    orderedBy: r.ordered_by,
    supplierOrderRef: r.supplier_order_ref,
  };
}

// ---------- sms logs ----------
export function dbSmsToDomain(r: Row<"sms_logs">): SmsLog {
  return {
    id: r.id,
    driverId: r.driver_id ?? "",
    jobId: r.job_id,
    body: r.body,
    sentAt: r.sent_at,
    twilioMessageId: r.twilio_message_id,
    deliveryStatus: r.delivery_status,
  };
}

// ---------- notifications ----------
export function dbNotificationToDomain(r: Row<"notifications">): Notification {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    body: r.body,
    link: r.link,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

// ---------- driver tokens ----------
export function dbDriverTokenToDomain(r: Row<"driver_tokens">): DriverToken {
  return {
    id: r.id,
    driverId: r.driver_id,
    token: r.token,
    scopedTo: r.scoped_to,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
  };
}

// ---------- vehicle inspections ----------
export function dbInspectionToDomain(
  r: Row<"vehicle_inspections">,
  items: Row<"inspection_items">[],
): VehicleInspection {
  const gpsCapture =
    r.gps_lat != null && r.gps_lng != null
      ? { lat: r.gps_lat, lng: r.gps_lng, capturedAt: r.gps_captured_at ?? r.submitted_at }
      : null;
  const geotabSnapshot: GeotabSnapshot | null =
    r.geotab_lat != null && r.geotab_lng != null
      ? {
          lat: r.geotab_lat,
          lng: r.geotab_lng,
          capturedAt: r.geotab_captured_at ?? r.submitted_at,
          distanceMeters: r.geotab_distance_meters ?? 0,
        }
      : null;
  const mapped: InspectionItem[] = items.map((it) => ({
    name: it.name,
    status: it.status,
    notes: it.notes,
  }));
  return {
    id: r.id,
    driverId: r.driver_id,
    vehicleId: r.vehicle_id,
    submittedAt: r.submitted_at,
    gpsCapture,
    geotabSnapshot,
    items: mapped,
    notes: r.notes,
    photos: r.photos,
    flagged: r.flagged,
  };
}

// ---------- rate tables ----------
// Combines a rate_tables row with its rate_line_items children. The line
// items table carries description/unit/rate/surcharges; the parent row is
// little more than (id, client_id) since RateTable in the domain is just a
// container for the list of priced line items used by approveWorkOrder.
export function dbRateTableToDomain(
  r: Row<"rate_tables">,
  lineItems: Row<"rate_line_items">[],
): RateTable {
  return {
    id: r.id,
    clientId: r.client_id,
    lineItems: lineItems
      .sort((a, b) => a.position - b.position)
      .map((li): RateLineItem => {
        // Surcharges are stored as Json on the row. Defensively coerce to the
        // typed array shape — bad payloads fall back to empty so the rate
        // lookup keeps working even with partial data.
        const raw: unknown[] = Array.isArray(li.surcharges) ? li.surcharges : [];
        const surcharges = raw
          .filter((s: unknown): s is { label: string; amount: number } =>
            !!s &&
            typeof s === "object" &&
            !Array.isArray(s) &&
            typeof (s as { label?: unknown }).label === "string" &&
            typeof (s as { amount?: unknown }).amount === "number",
          )
          .map((s: { label: string; amount: number }) => ({ label: s.label, amount: s.amount }));
        return {
          description: li.description,
          unit: li.unit as RateLineItem["unit"],
          rate: Number(li.rate),
          surcharges,
        };
      }),
  };
}

// ---------- maintenance logs ----------
export function dbMaintenanceLogToDomain(r: Row<"maintenance_logs">): MaintenanceLog {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    type: r.type,
    performedBy: r.performed_by,
    date: r.date,
    mileage: r.mileage,
    cost: Number(r.cost),
    notes: r.notes,
    attachments: r.attachments,
  };
}

export function domainMaintenanceLogToDb(m: MaintenanceLog): Insert<"maintenance_logs"> {
  return {
    id: m.id,
    vehicle_id: m.vehicleId,
    type: m.type,
    performed_by: m.performedBy,
    date: m.date,
    mileage: m.mileage,
    cost: m.cost,
    notes: m.notes,
    attachments: m.attachments,
  };
}

// ---------- fuel logs ----------
export function dbFuelLogToDomain(r: Row<"fuel_logs">): FuelLog {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    date: r.date,
    gallons: Number(r.gallons),
    cost: Number(r.cost),
    location: r.location,
    driverId: r.driver_id ?? "",
  };
}

export function domainFuelLogToDb(f: FuelLog): Insert<"fuel_logs"> {
  return {
    id: f.id,
    vehicle_id: f.vehicleId,
    date: f.date,
    gallons: f.gallons,
    cost: f.cost,
    location: f.location,
    driver_id: f.driverId || null,
  };
}

// ---------- maintenance work orders (mechanic queue) ----------
// Defensive parse for parts_used jsonb. Each entry should be
// { inventoryItemId, qty, notes? } — anything else is dropped so the row stays
// renderable even if a legacy payload shows up.
function parseMaintenancePartsUsed(raw: unknown): MaintenanceWorkOrderPart[] {
  if (!Array.isArray(raw)) return [];
  const out: MaintenanceWorkOrderPart[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.inventoryItemId === "string" && typeof e.qty === "number") {
      const part: MaintenanceWorkOrderPart = {
        inventoryItemId: e.inventoryItemId,
        qty: e.qty,
      };
      if (typeof e.notes === "string") part.notes = e.notes;
      out.push(part);
    }
  }
  return out;
}

export function dbMaintenanceWorkOrderToDomain(
  r: Row<"maintenance_work_orders">,
): MaintenanceWorkOrder {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    reportedBy: r.reported_by,
    reportedFrom: r.reported_from as MaintenanceWorkOrderSource,
    sourceInspectionId: r.source_inspection_id,
    issueDescription: r.issue_description,
    priority: r.priority as MaintenanceWorkOrderPriority,
    status: r.status as MaintenanceWorkOrderStatus,
    assignedMechanicId: r.assigned_mechanic_id,
    claimedAt: r.claimed_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    partsUsed: parseMaintenancePartsUsed(r.parts_used),
    laborHours: Number(r.labor_hours),
    laborNotes: r.labor_notes,
    finalCost: r.final_cost != null ? Number(r.final_cost) : null,
    completionNotes: r.completion_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- ticket transactions ----------
export function dbTicketTxnToDomain(r: Row<"ticket_transactions">): TicketTransaction {
  return {
    id: r.id,
    clientId: r.client_id,
    kind: r.kind,
    qty: r.qty,
    balanceAfter: r.balance_after,
    occurredAt: r.occurred_at,
    workOrderId: r.work_order_id,
    vehicleId: r.vehicle_id,
    dumpSite: r.dump_site,
    reason: r.reason,
  };
}

// ---------- ticket replenishments ----------
export function dbTicketRepToDomain(r: Row<"ticket_replenishments">): TicketReplenishment {
  return {
    id: r.id,
    clientId: r.client_id,
    invoiceDataId: r.invoice_data_id,
    qty: r.qty,
    amount: Number(r.amount),
    triggeredAt: r.triggered_at,
    autoBilled: r.auto_billed,
    qboSyncStatus: r.qbo_sync_status,
    qboInvoiceId: r.qbo_invoice_id,
  };
}

// ---------- ticket photos ----------
export function dbTicketPhotoToDomain(r: Row<"ticket_photos">): TicketPhoto {
  return {
    id: r.id,
    jobId: r.job_id,
    driverId: r.driver_id,
    photoUrl: r.photo_url,
    weight: r.weight != null ? Number(r.weight) : null,
    location: r.location,
    enteredBy: r.entered_by,
    status: r.status,
    uploadedAt: r.uploaded_at,
  };
}
