export type UserRole = 'admin' | 'driver' | 'mechanic';
export type UserStatus = 'active' | 'inactive' | 'suspended';

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
  status: 'active' | 'inactive';
}

export interface RateLineItem {
  description: string;
  unit: 'hour' | 'tonne' | 'load' | 'flat';
  rate: number;
  surcharges: { label: string; amount: number }[];
}

export interface RateTable {
  id: string;
  clientId: string;
  lineItems: RateLineItem[];
}

export type VehicleType = 'truck' | 'trailer' | 'equipment';
export type VehicleStatus = 'operational' | 'maintenance' | 'out-of-service';

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

export type ToolCondition = 'ok' | 'missing' | 'damaged';

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

export interface ToolChecklistSubmission {
  id: string;
  driverId: string;
  vehicleId: string;
  submittedAt: string;
  gpsLat: number | null;
  gpsLng: number | null;
  items: ToolChecklistItem[];
}

export type JobStatus = 'scheduled' | 'active' | 'completed' | 'delayed' | 'cancelled';

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
  createdBy: string;
  createdAt: string;
}

export type WorkOrderStatus = 'pending' | 'approved' | 'rejected';

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

export type QboSyncStatus = 'not-synced' | 'pending' | 'synced' | 'failed';

export interface InvoiceData {
  id: string;
  workOrderId: string;
  clientId: string;
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
  vehicleMovementCorrelation: 'matches' | 'mismatch' | 'pending';
  flagged: boolean;
  flagReason: string;
}

export type PurchaseRequestStatus = 'pending' | 'approved' | 'rejected' | 'ordered';

export interface PurchaseRequest {
  id: string;
  mechanicId: string;
  item: string;
  reason: string;
  estimatedCost: number;
  urgency: 'low' | 'medium' | 'high';
  inventoryCheckedAt: string | null;
  status: PurchaseRequestStatus;
  approvedBy: string | null;
  supplierId: string | null;
  createdAt: string;
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
}

export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed';

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
  type: 'job' | 'approval' | 'alert' | 'system';
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export type TokenScope = 'forms' | 'job' | 'shift';

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
  status: 'awaiting-entry' | 'entered';
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