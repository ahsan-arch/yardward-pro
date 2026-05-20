import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import * as seed from "@/data/mockData";
import type {
  Job, WorkOrder, PurchaseRequest, ToolChecklistSubmission, TimeEntry,
  SmsLog, DriverToken, InvoiceData, TokenScope,
} from "@/types/domain";

type Ctx = {
  drivers: typeof seed.drivers;
  mechanics: typeof seed.mechanics;
  vehicles: typeof seed.vehicles;
  clients: typeof seed.clients;
  rateTables: typeof seed.rateTables;
  jobs: Job[];
  workOrders: WorkOrder[];
  invoiceData: InvoiceData[];
  maintenanceLogs: typeof seed.maintenanceLogs;
  fuelLogs: typeof seed.fuelLogs;
  tools: typeof seed.tools;
  toolChecklistSubmissions: ToolChecklistSubmission[];
  purchaseRequests: PurchaseRequest[];
  inventoryItems: typeof seed.inventoryItems;
  smsLogs: SmsLog[];
  notifications: typeof seed.notifications;
  driverTokens: DriverToken[];
  ticketPhotos: typeof seed.ticketPhotos;
  tenders: typeof seed.tenders;
  timeEntries: TimeEntry[];
  createJob: (job: Job) => void;
  updateJob: (id: string, patch: Partial<Job>) => void;
  submitWorkOrder: (wo: WorkOrder) => void;
  approveWorkOrder: (id: string, approverId: string, invoice: InvoiceData) => void;
  rejectWorkOrder: (id: string, reason: string) => void;
  submitToolChecklist: (s: ToolChecklistSubmission) => void;
  submitStartOfDay: (entry: TimeEntry) => void;
  submitEndOfDay: (entryId: string, patch: Partial<TimeEntry>) => void;
  submitPurchaseRequest: (req: PurchaseRequest) => void;
  approvePurchaseRequest: (id: string, approverId: string) => void;
  clockIn: (entry: TimeEntry) => void;
  clockOut: (entryId: string, patch: Partial<TimeEntry>) => void;
  addSms: (sms: SmsLog) => void;
  generateDriverToken: (token: DriverToken) => void;
  markTokenUsed: (id: string) => void;
};

const DataCtx = createContext<Ctx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>(seed.jobs);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(seed.workOrders);
  const [invoiceData, setInvoiceData] = useState<InvoiceData[]>(seed.invoiceData);
  const [toolChecklistSubmissions, setToolSubs] = useState<ToolChecklistSubmission[]>(seed.toolChecklistSubmissions);
  const [purchaseRequests, setPRs] = useState<PurchaseRequest[]>(seed.purchaseRequests);
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>(seed.smsLogs);
  const [driverTokens, setTokens] = useState<DriverToken[]>(seed.driverTokens);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>(seed.timeEntries);

  const createJob = useCallback((job: Job) => setJobs(j => [job, ...j]), []);
  const updateJob = useCallback((id: string, patch: Partial<Job>) =>
    setJobs(j => j.map(x => x.id === id ? { ...x, ...patch } : x)), []);
  const submitWorkOrder = useCallback((wo: WorkOrder) => setWorkOrders(w => [wo, ...w]), []);
  const approveWorkOrder = useCallback((id: string, approverId: string, invoice: InvoiceData) => {
    setWorkOrders(w => w.map(x => x.id === id ? { ...x, status: "approved", approvedBy: approverId, approvedAt: new Date().toISOString(), invoiceDataId: invoice.id } : x));
    setInvoiceData(inv => [invoice, ...inv]);
  }, []);
  const rejectWorkOrder = useCallback((id: string, reason: string) =>
    setWorkOrders(w => w.map(x => x.id === id ? { ...x, status: "rejected", siteIssuesNote: reason || x.siteIssuesNote, approvedAt: new Date().toISOString() } : x)), []);
  const submitToolChecklist = useCallback((s: ToolChecklistSubmission) => setToolSubs(arr => [s, ...arr]), []);
  const submitStartOfDay = useCallback((entry: TimeEntry) => setTimeEntries(arr => [entry, ...arr]), []);
  const submitEndOfDay = useCallback((entryId: string, patch: Partial<TimeEntry>) =>
    setTimeEntries(arr => arr.map(x => x.id === entryId ? { ...x, ...patch } : x)), []);
  const submitPurchaseRequest = useCallback((req: PurchaseRequest) => setPRs(arr => [req, ...arr]), []);
  const approvePurchaseRequest = useCallback((id: string, approverId: string) =>
    setPRs(arr => arr.map(x => x.id === id ? { ...x, status: "approved", approvedBy: approverId } : x)), []);
  const clockIn = useCallback((entry: TimeEntry) => setTimeEntries(arr => [entry, ...arr]), []);
  const clockOut = useCallback((entryId: string, patch: Partial<TimeEntry>) =>
    setTimeEntries(arr => arr.map(x => x.id === entryId ? { ...x, ...patch } : x)), []);
  const addSms = useCallback((sms: SmsLog) => setSmsLogs(arr => [sms, ...arr]), []);
  const generateDriverToken = useCallback((token: DriverToken) => setTokens(arr => [token, ...arr]), []);
  const markTokenUsed = useCallback((id: string) =>
    setTokens(arr => arr.map(x => x.id === id ? { ...x, usedAt: new Date().toISOString() } : x)), []);

  return (
    <DataCtx.Provider value={{
      drivers: seed.drivers, mechanics: seed.mechanics, vehicles: seed.vehicles,
      clients: seed.clients, rateTables: seed.rateTables,
      jobs, workOrders, invoiceData,
      maintenanceLogs: seed.maintenanceLogs, fuelLogs: seed.fuelLogs,
      tools: seed.tools, toolChecklistSubmissions,
      purchaseRequests, inventoryItems: seed.inventoryItems,
      smsLogs, notifications: seed.notifications, driverTokens,
      ticketPhotos: seed.ticketPhotos, tenders: seed.tenders, timeEntries,
      createJob, updateJob,
      submitWorkOrder, approveWorkOrder, rejectWorkOrder,
      submitToolChecklist, submitStartOfDay, submitEndOfDay,
      submitPurchaseRequest, approvePurchaseRequest,
      clockIn, clockOut, addSms,
      generateDriverToken, markTokenUsed,
    }}>
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