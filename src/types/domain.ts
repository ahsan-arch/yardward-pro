export type UserRole = "admin" | "driver" | "mechanic";
export type UserStatus = "active" | "inactive" | "suspended";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  phone: string;
  status: UserStatus;
  createdAt: string;
}

export interface Driver extends User {
  licenseNumber: string;
  licenseExpiry: string;
  vehicleAssignmentId: string | null;
  currentTokenId: string | null;
  initials: string;
}

export interface Mechanic extends User {
  specialty: string;
  shopId: string;
  isWorkshopManager: boolean;
}

// Plain admin profile — no side-table fields. Used by the Users tab to list
// real admins instead of the previous hardcoded placeholder.
export type Admin = User;

// Named custom admin role: a checklist of admin tab keys (see
// src/lib/admin-tabs.ts for the canonical key list and resolution rules).
export interface AdminRole {
  id: string;
  name: string;
  allowedTabs: string[];
}

// Per-admin access settings as stored on profiles. Only meaningful for
// role === "admin" users; owner accounts always resolve to full access.
export interface AdminAccess {
  isOwner: boolean;
  adminRoleId: string | null;
  allowedTabsOverride: string[] | null;
}

export type TicketReportFrequency = "off" | "daily" | "weekly" | "monthly";

export interface ClientTicketSettings {
  enabled: boolean;
  balance: number;
  threshold: number;
  bundleSize: number;
  bundlePrice: number;
  autoBillEnabled: boolean;
  reportFrequency: TicketReportFrequency;
  reportRecipients: string[];
}

export interface Client {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  billingAddress: string;
  rateTableId: string | null;
  notes: string;
  status: "active" | "inactive";
  tickets: ClientTicketSettings;
}

export type TicketTxnKind = "debit" | "credit" | "adjustment";

export interface TicketTransaction {
  id: string;
  clientId: string;
  kind: TicketTxnKind;
  qty: number;
  balanceAfter: number;
  occurredAt: string;
  workOrderId: string | null;
  vehicleId: string | null;
  dumpSite: string | null;
  reason: string;
}

export type TicketReplenishmentStatus = "not-synced" | "pending" | "synced" | "failed";

export interface TicketReplenishment {
  id: string;
  clientId: string;
  invoiceDataId: string;
  qty: number;
  amount: number;
  triggeredAt: string;
  autoBilled: boolean;
  qboSyncStatus: TicketReplenishmentStatus;
  qboInvoiceId: string | null;
}

export interface RateLineItem {
  description: string;
  unit: "hour" | "tonne" | "load" | "flat";
  rate: number;
  surcharges: { label: string; amount: number }[];
}

export interface RateTable {
  id: string;
  clientId: string;
  lineItems: RateLineItem[];
}

export type VehicleType = "truck" | "trailer" | "equipment";
export type VehicleStatus = "operational" | "maintenance" | "out-of-service";

export interface Vehicle {
  id: string;
  name: string;
  plate: string;
  year: number;
  type: VehicleType;
  vin: string;
  odometer: number;
  engineHours: number;
  lastService: string;
  nextServiceDue: string;
  driverId: string | null;
  geotabDeviceId: string | null;
  status: VehicleStatus;
  // Live telematics (populated by the Geotab cron). All optional / nullable so
  // mock data and pre-cron rows stay valid.
  latitude?: number | null;
  longitude?: number | null;
  speedMph?: number | null;
  speedKmh?: number | null;
  isDriving?: boolean | null;
  lastSeenAt?: string | null;
  locationUpdatedAt?: string | null;
  /**
   * Timestamp (ISO) of the most recent passing pre-trip inspection for this
   * vehicle. When null OR older than the lockout window (12h) drivers must
   * complete a fresh circle-check before clocking in. Mirrors the SQL
   * column `vehicles.last_pretrip_at` and backs MTO/CVOR record-keeping.
   */
  lastPretripAt?: string | null;
}

export interface MaintenanceLog {
  id: string;
  vehicleId: string;
  type: string;
  performedBy: string;
  date: string;
  mileage: number;
  cost: number;
  notes: string;
  attachments: string[];
}

export interface FuelLog {
  id: string;
  vehicleId: string;
  date: string;
  gallons: number;
  cost: number;
  location: string;
  driverId: string;
}

export type ToolCondition = "ok" | "missing" | "damaged";

export interface Tool {
  id: string;
  name: string;
  condition: ToolCondition;
  vehicleId: string | null;
}

export interface ToolChecklistItem {
  toolId: string;
  status: ToolCondition;
  notes: string;
}

export type ToolChecklistKind = "start_of_shift" | "end_of_shift";

export interface ToolChecklistSubmission {
  id: string;
  driverId: string;
  vehicleId: string;
  kind: ToolChecklistKind;
  submittedAt: string;
  gpsLat: number | null;
  gpsLng: number | null;
  items: ToolChecklistItem[];
}

export type JobStatus = "draft" | "scheduled" | "active" | "completed" | "delayed" | "cancelled";

export interface Job {
  id: string;
  clientId: string;
  location: { address: string; lat: number | null; lng: number | null };
  scheduledAt: string;
  durationMin: number;
  driverId: string | null;
  vehicleId: string | null;
  status: JobStatus;
  notes: string;
  /**
   * Free-text equipment names dispatch attaches to this job beyond the
   * assigned vehicle (e.g. "300ft hose reel", "extra jetting nozzle"). Client
   * feedback: "Job Menu doesn't have any way to assign additional equipment
   * or to trigger other departments" / "When dispatch selects additional
   * equipment, the responsible department must automatically receive a task
   * to prepare that equipment before the truck leaves the yard." Setting this
   * on create fires a notification to every mechanic (see createJob).
   */
  additionalEquipment: string[];
  createdBy: string;
  createdAt: string;
}

/**
 * Free-form note a driver attaches to a job mid-shift. Separate from the
 * end-of-shift WorkOrder — this is for "stuck behind a gate", "site supervisor
 * changed dump location", etc. Persisted to `public.job_logs` with RLS so each
 * driver only sees their own rows; admins see everything for the job detail
 * sheet.
 */
export interface JobLog {
  id: string;
  jobId: string;
  driverId: string;
  vehicleId: string | null;
  body: string;
  gpsLat: number | null;
  gpsLng: number | null;
  loggedAt: string;
  createdAt: string;
}

// Native hauling record (dump / load form) captured in the driver app.
// Replaces Formstack for new submissions; distinct from WorkOrder, which is
// the billing-side capture with foreman signature + approval flow. Persisted
// to public.dump_logs with the same RLS shape as job_logs.
export interface DumpLog {
  id: string;
  // Null for client-portal submissions (external drivers are not auth users;
  // their name + truck arrive as text in submittedName / truckNumber).
  driverId: string | null;
  jobId: string | null;
  vehicleId: string | null;
  // Portal fields (Phase 1 of the Formstack replacement).
  clientId: string | null;
  submissionCode: string | null;
  source: "driver-app" | "client-portal";
  submittedName: string;
  truckNumber: string;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  loadType: string;
  quantity: string;
  weight: string;
  location: string;
  receivingSite: string;
  notes: string;
  gpsLat: number | null;
  gpsLng: number | null;
  loggedAt: string;
  createdAt: string;
}

export type WorkOrderStatus = "pending" | "approved" | "rejected";

export interface WorkOrder {
  id: string;
  jobId: string;
  driverId: string;
  workPerformed: string;
  loadType: string;
  weightTonnes: number;
  dumpSite: string;
  gpsCapture: { lat: number; lng: number; capturedAt: string } | null;
  foremanSignature: string;
  siteIssues: boolean;
  siteIssuesNote: string;
  submittedAt: string;
  status: WorkOrderStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  invoiceDataId: string | null;
}

export type QboSyncStatus = "not-synced" | "pending" | "synced" | "failed";

export type InvoiceKind = "work-order" | "ticket-replenishment";

export interface InvoiceData {
  id: string;
  workOrderId: string;
  clientId: string;
  kind: InvoiceKind;
  lineItems: { description: string; qty: number; rate: number; amount: number }[];
  total: number;
  qboSyncStatus: QboSyncStatus;
  qboInvoiceId: string | null;
}

export interface TimeEntry {
  id: string;
  driverId: string;
  clockIn: string;
  clockOut: string | null;
  gpsClockIn: { lat: number; lng: number } | null;
  gpsClockOut: { lat: number; lng: number } | null;
  vehicleMovementCorrelation: "matches" | "mismatch" | "pending";
  flagged: boolean;
  flagReason: string;
  /**
   * The VehicleInspection.id (a passing circle-check, <12h old) that
   * authorised this clock-in. Required by the pre-trip lockout — without
   * it the driver couldn't have started the shift. Stays null only for
   * legacy/seed entries that pre-date the lockout.
   */
  pretripInspectionId?: string | null;
  /**
   * Start-of-day "Any personal PPE missing?" toggle + the required reason
   * text. Optional for the same reason pretripInspectionId is: the quick
   * clockIn/clockOut path and legacy/seed rows never went through the
   * start-of-day form that captures it.
   */
  ppeMissing?: boolean;
  ppeMissingReason?: string;
  /**
   * "Passengers in vehicle?" toggle from the start-of-day form, expanded to
   * an actual name manifest — a safety-relevant boolean with no names behind
   * it is useless if dispatch ever needs to know who was on board. Optional
   * for the same legacy/seed reason as pretripInspectionId.
   */
  passengerNames?: string[];
}

export type PurchaseRequestStatus = "pending" | "approved" | "rejected" | "ordered";

/**
 * Snapshot of stock visible to the mechanic at submission time, persisted to
 * `purchase_requests.inventory_check_result` (jsonb). Lets admins see exactly
 * what we had on hand when the request was filed — so if a mechanic ordered
 * brake pads while 4 sets were sitting in SHOP-01, the audit trail says so.
 */
export interface InventoryCheckSnapshot {
  inventoryItemId: string;
  name: string;
  sku: string;
  qtyOnHand: number;
  supplierId: string;
}

export interface PurchaseRequest {
  id: string;
  mechanicId: string;
  item: string;
  quantity: number;
  reason: string;
  estimatedCost: number;
  urgency: "low" | "medium" | "high";
  inventoryCheckedAt: string | null;
  /**
   * Stock snapshot captured by the in-form inventory search at submission.
   * Empty array means "checked, found nothing"; null means "the mechanic
   * never toggled the check" (legacy rows). Admin review surfaces this.
   */
  inventoryCheckResult: InventoryCheckSnapshot[] | null;
  status: PurchaseRequestStatus;
  approvedBy: string | null;
  supplierId: string | null;
  createdAt: string;
  /**
   * Stock units reserved against inventory_items at approval time. 1 when the
   * fuzzy name/sku match found an item with enough on-hand stock to cover the
   * request and we bumped its qty_reserved; 0 when there was no match or no
   * stock (in which case the PR still moves to 'approved' but will need a
   * real supplier order). Null on legacy rows from before this column was
   * introduced — treat as "unknown" rather than "definitely zero".
   */
  inventoryDecrementQty: number | null;
  /**
   * Set by api.markPurchaseRequestOrdered once an admin places the actual
   * supplier order. Null until then.
   */
  orderedAt: string | null;
  orderedBy: string | null;
  supplierOrderRef: string | null;
}

export interface InventoryItem {
  id: string;
  name: string;
  sku: string;
  qtyOnHand: number;
  qtyReserved: number;
  reorderPoint: number;
  supplierId: string;
  lastRestocked: string;
  /** Shelf/bin location — client feedback: "No ability to enter locations". */
  location: string;
  /** Free-text grouping (e.g. "Fluids", "Brakes") — no categories table exists,
   *  so this is a plain field; the inventory list derives its filter dropdown
   *  from whatever distinct values are already in use. */
  category: string;
  manufacturer: string;
  /** The manufacturer's own part #, distinct from our internal `sku`. */
  manufacturerPartNumber: string;
  /** A cross-reference part # from a different manufacturer/catalog. */
  alternativePartNumber: string;
  /** Same loose string-id convention as `supplierId` — a second supplier to
   *  fall back on when the primary is out of stock or slow. */
  alternativeSupplierId: string;
  /**
   * Storage PATH (not a baked signed URL) into the private `part-photos`
   * bucket, or a `data:` URL in mock mode — same convention as
   * TicketPhoto.photoUrl. Views mint a fresh signed URL on demand via
   * api.signInventoryPhotoUrl so a stale link never 403s an <img>.
   */
  photoUrl: string;
  /**
   * Assignment for trackable/high-value parts (Fleetio pressure point #4:
   * "isn't designed to manage parts that may be assigned to vehicles or
   * actual operators/users... equipment that seem to be displaced at the
   * worst possible times"). Mutually exclusive with assignedUserId — a part
   * is either on a truck, checked out to a person, or sitting in the spare
   * pool (both null). "Transfer" is just editing this field again.
   */
  assignedVehicleId: string | null;
  assignedUserId: string | null;
  /**
   * Soft-hide, not a delete — a retired/superseded part still has to keep
   * every historical reference to it intact (purchase requests, work-order
   * parts_used, maintenance logs all point at inventory_items.id).
   * Archived parts drop out of the active list, the low-stock count, and
   * every part-picker across the app.
   */
  archived: boolean;
  /**
   * Bill of Materials flag — this part number represents a kit of other
   * parts (see BomComponent) rather than its own physically-stocked row.
   * Client feedback: "one part number that represents many part numbers...
   * even a decant hose... is made up of four part numbers." Allocating a
   * BOM part decrements its components (bom_components), not this row's
   * own qty_on_hand.
   */
  isBom: boolean;
  /**
   * Consumable/non-stock part — client's #1 Fleetio complaint: forcing every
   * part into strict qty tracking produced a stores count that drifted from
   * reality for one-off purchases. When true, qtyOnHand/reorderPoint are
   * still stored but never enforced: no low-stock alert, no PR reservation,
   * no work-order-completion decrement.
   */
  isUntracked: boolean;
}

/**
 * One component line of a BOM part's recipe. qtyPer is how many units of
 * the component one unit of the parent BOM part consumes.
 */
export interface BomComponent {
  id: string;
  parentItemId: string;
  componentItemId: string;
  qtyPer: number;
}

/**
 * Core-return / surcharge-credit audit trail. Client feedback: "A customer
 * returns a pump. It has a core value. The pump is returned to the
 * supplier. The supplier issues a credit. I need the system to track every
 * stage automatically until the credit is received and applied." A pure
 * financial/paper trail — never touches inventory_items.qty_on_hand.
 */
export type CoreReturnStatus = "received" | "returned_to_supplier" | "credited";

export interface CoreReturn {
  id: string;
  partDescription: string;
  /** Optional correlation to the catalog part that carries this core value. */
  inventoryItemId: string | null;
  coreValue: number;
  customerName: string;
  status: CoreReturnStatus;
  receivedAt: string;
  /** Same loose string-id convention as inventory_items.supplierId. */
  supplierId: string | null;
  /** RTS = Return To Supplier — the client's own term for the paper note. */
  rtsReference: string;
  rtsAt: string | null;
  creditAmount: number | null;
  creditedAt: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
}

export type SmsDeliveryStatus = "queued" | "sent" | "delivered" | "failed";

export interface SmsLog {
  id: string;
  driverId: string;
  jobId: string | null;
  body: string;
  sentAt: string;
  twilioMessageId: string | null;
  deliveryStatus: SmsDeliveryStatus;
}

export interface Notification {
  id: string;
  userId: string;
  type: "job" | "approval" | "alert" | "system";
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export type TokenScope = "forms" | "job" | "shift" | "tickets";

export interface DriverToken {
  id: string;
  driverId: string;
  token: string;
  scopedTo: TokenScope;
  expiresAt: string;
  usedAt: string | null;
}

export interface TicketPhoto {
  id: string;
  jobId: string;
  driverId: string;
  photoUrl: string;
  weight: number | null;
  location: string | null;
  enteredBy: string | null;
  status: "awaiting-entry" | "entered";
  uploadedAt: string;
}

export interface Tender {
  id: string;
  source: string;
  title: string;
  url: string;
  closingDate: string;
  summary: string;
  scrapedAt: string;
}

export type InspectionItemStatus = "ok" | "issue";

export interface InspectionItem {
  name: string;
  status: InspectionItemStatus;
  notes: string;
}

export interface GeotabSnapshot {
  lat: number;
  lng: number;
  capturedAt: string;
  distanceMeters: number;
}

export interface VehicleInspection {
  id: string;
  driverId: string;
  vehicleId: string;
  submittedAt: string;
  gpsCapture: { lat: number; lng: number; capturedAt: string } | null;
  geotabSnapshot: GeotabSnapshot | null;
  items: InspectionItem[];
  notes: string;
  photos: string[];
  flagged: boolean;
}

// Mechanic-side work order queue (separate from driver-side WorkOrder). Backed
// by public.maintenance_work_orders. Created either by the failed-inspection
// trigger, an admin from the maintenance dashboard, or a driver note.
export type MaintenanceWorkOrderStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "completed"
  | "cancelled";
export type MaintenanceWorkOrderPriority = "low" | "medium" | "high" | "critical";
export type MaintenanceWorkOrderSource = "inspection" | "admin" | "driver_note" | "mechanic";

export interface MaintenanceWorkOrderPart {
  inventoryItemId: string;
  qty: number;
  notes?: string;
}

export interface MaintenanceWorkOrder {
  id: string;
  vehicleId: string;
  reportedBy: string | null;
  reportedFrom: MaintenanceWorkOrderSource;
  sourceInspectionId: string | null;
  issueDescription: string;
  priority: MaintenanceWorkOrderPriority;
  status: MaintenanceWorkOrderStatus;
  assignedMechanicId: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  partsUsed: MaintenanceWorkOrderPart[];
  laborHours: number;
  laborNotes: string;
  finalCost: number | null;
  completionNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Photo a mechanic attaches to a work order while it's in progress (before/
 * after shots, damage evidence, etc.). Client feedback (Mechanic Profile #9):
 * "how are the Work Orders going to be structured e.g. with service tasks
 * and inventory ability with photos etc. as this is crucial." Mirrors
 * TicketPhoto's storage-path-not-baked-URL pattern.
 */
export interface WorkOrderPhoto {
  id: string;
  workOrderId: string;
  mechanicId: string | null;
  photoUrl: string;
  uploadedAt: string;
}

/**
 * Singleton org-wide settings. Mirrors the `public.app_settings` row.
 * Inspection duration bounds drive the pre-trip lockout backdating: each
 * submitted inspection's `submittedAt` is rewound by a random value in
 * `[inspectionMinDurationSeconds, inspectionMaxDurationSeconds]` so the
 * recorded time on the inspection looks like a legitimate 13–20min walk-
 * around instead of the 90-second drive-throughs the MTO flags. Read by
 * drivers (tolerance values), written by admins (everything).
 */
// Notification preferences live in app_settings.notification_preferences as
// jsonb. Boolean per channel — switches off in the UI flip the value to false.
// Defaults match the seeded migration values.
export interface NotificationPreferences {
  newJobAssignedSms: boolean;
  workOrderAwaitingApproval: boolean;
  toolFlaggedOnChecklist: boolean;
  gpsMismatchOnTimeEntry: boolean;
  poAwaitingApproval: boolean;
  vehicleMaintenanceOverdue: boolean;
  dailySummaryEmail: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  newJobAssignedSms: true,
  workOrderAwaitingApproval: true,
  toolFlaggedOnChecklist: true,
  gpsMismatchOnTimeEntry: true,
  poAwaitingApproval: true,
  vehicleMaintenanceOverdue: false,
  dailySummaryEmail: false,
};

// Per-user notification preferences. Distinct from the org-wide flags in
// AppSettings — these let an individual driver/mechanic opt in/out of
// channels for themselves regardless of org defaults.
export interface UserNotificationPreferences {
  newJobAssignedSms: boolean;
  workOrderAwaitingApproval: boolean;
  toolFlaggedOnChecklist: boolean;
  shiftReminders: boolean;
  maintenanceAlerts: boolean;
  dailySummaryEmail: boolean;
}

export const DEFAULT_USER_NOTIFICATION_PREFERENCES: UserNotificationPreferences = {
  newJobAssignedSms: true,
  workOrderAwaitingApproval: true,
  toolFlaggedOnChecklist: true,
  shiftReminders: true,
  maintenanceAlerts: true,
  dailySummaryEmail: false,
};

// Billing subscription state — admin-only, lives as columns on the
// app_settings singleton row. Cancellations flow through the SECDEF
// request_cancel_subscription RPC which also drops a notification on
// every admin profile.
export type BillingStatus = "active" | "cancel-requested" | "cancelled" | "past-due";

export interface BillingSubscription {
  planName: string;
  renewalDate: string | null;
  seatsLimit: number;
  vehiclesLimit: number;
  status: BillingStatus;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  /**
   * Self-service "ask for more" ping (see 20260718090000_vehicle_capacity_
   * request.sql) — client feedback worried this system would repeat
   * Fleetio's "expensive to add more vehicles" hard limit. vehiclesLimit is
   * never enforced as a technical cap; this just lets an admin flag that
   * they've outgrown it without needing a developer to bump a constant.
   */
  vehicleCapacityRequestedAt: string | null;
  vehicleCapacityRequestNote: string | null;
}

export const DEFAULT_BILLING_SUBSCRIPTION: BillingSubscription = {
  planName: "Fleet — up to 25 drivers",
  renewalDate: null,
  seatsLimit: 25,
  vehiclesLimit: 50,
  status: "active",
  cancelRequestedAt: null,
  cancelReason: null,
  vehicleCapacityRequestedAt: null,
  vehicleCapacityRequestNote: null,
};

export interface SupportTicket {
  id: string;
  userId: string | null;
  userEmail: string;
  subject: string;
  body: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
}

export interface AppSettings {
  gpsToleranceMinutes: number;
  overtimeWarningHours: number;
  overtimeAlertHours: number;
  inspectionMinDurationSeconds: number;
  inspectionMaxDurationSeconds: number;
  // Organization profile (admin/settings → Organization profile tab)
  businessName: string;
  taxId: string;
  address: string;
  timezone: string;
  currency: string;
  // Notification preferences (admin/settings → Notifications tab)
  notificationPreferences: NotificationPreferences;
  // Billing (admin/settings → Billing tab)
  billing: BillingSubscription;
  updatedAt: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  gpsToleranceMinutes: 15,
  overtimeWarningHours: 40,
  overtimeAlertHours: 44,
  inspectionMinDurationSeconds: 780,
  inspectionMaxDurationSeconds: 1200,
  businessName: "",
  taxId: "",
  address: "",
  timezone: "America/Toronto",
  currency: "CAD",
  notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
  billing: DEFAULT_BILLING_SUBSCRIPTION,
  updatedAt: new Date(0).toISOString(),
};

// =============================================================================
// Communications — driver↔mechanic threading with admin oversight
// =============================================================================

export type ConversationTopic = "general" | "job" | "vehicle" | "maintenance";
export type ConversationStatus = "active" | "archived" | "closed";
export type ParticipantRole = "originator" | "admin" | "mechanic" | "driver";
export type MessageSenderKind = "in_app" | "sms" | "system";
export type MessageDeliveryStatus = "queued" | "sent" | "delivered" | "failed" | "received";

export interface Conversation {
  id: string;
  twilioConversationSid: string | null;
  topic: ConversationTopic;
  topicRefId: string | null;
  subject: string;
  status: ConversationStatus;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  closedBy: string | null;
  resolutionNotes: string | null;
}

export interface ConversationParticipant {
  id: string;
  conversationId: string;
  userId: string;
  participantRole: ParticipantRole;
  twilioParticipantSid: string | null;
  joinedAt: string;
  leftAt: string | null;
  lastReadAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  twilioMessageSid: string | null;
  idempotencyKey: string | null;
  senderId: string;
  senderKind: MessageSenderKind;
  body: string;
  mediaPaths: string[];
  twilioMediaUrls: string[];
  deliveryStatus: MessageDeliveryStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
