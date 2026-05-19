export type Status = "Active" | "Scheduled" | "Completed" | "Delayed" | "Pending" | "Approved" | "Rejected" | "Operational" | "In maintenance";

export const drivers = [
  { id: "D-01", name: "Tom Morrison", initials: "TM", phone: "+1 555 0142", license: "HR-A" },
  { id: "D-02", name: "Raja Singh", initials: "RS", phone: "+1 555 0188", license: "HR-A" },
  { id: "D-03", name: "Dana Clarke", initials: "DC", phone: "+1 555 0156", license: "MR" },
  { id: "D-04", name: "Kenji Park", initials: "KP", phone: "+1 555 0172", license: "HR-B" },
  { id: "D-05", name: "Abby Walsh", initials: "AW", phone: "+1 555 0119", license: "MR" },
  { id: "D-06", name: "Marcus Bell", initials: "MB", phone: "+1 555 0163", license: "HR-A" },
];

export const trucks = [
  { id: "TRK-03", name: "Kenworth T610", year: 2020, type: "Truck", odometer: 112430, hours: 4210, lastService: "02 Apr 2025", nextDue: "120,000 km", status: "Operational" as const, driver: "Raja Singh" },
  { id: "TRK-07", name: "Mack Granite", year: 2021, type: "Truck", odometer: 84220, hours: 3104, lastService: "12 Apr 2025", nextDue: "90,000 km", status: "Operational" as const, driver: "Tom Morrison" },
  { id: "TRK-11", name: "Volvo FH", year: 2022, type: "Truck", odometer: 56780, hours: 2018, lastService: "28 Mar 2025", nextDue: "60,000 km", status: "Operational" as const, driver: "Dana Clarke" },
  { id: "TRK-14", name: "Isuzu FXZ", year: 2019, type: "Truck", odometer: 198400, hours: 7320, lastService: "01 May 2025", nextDue: "Service overdue", status: "In maintenance" as const, driver: "Unassigned" },
  { id: "EQ-02",  name: "CAT 320 Excavator", year: 2020, type: "Equipment", odometer: 0, hours: 5410, lastService: "18 Apr 2025", nextDue: "5,800 hrs", status: "Operational" as const, driver: "Kenji Park" },
  { id: "TRL-01", name: "Flat-deck trailer", year: 2018, type: "Trailer", odometer: 142000, hours: 0, lastService: "10 Feb 2025", nextDue: "150,000 km", status: "Operational" as const, driver: "Marcus Bell" },
];

export const clients = ["Maple City Council", "Brennan Demolition", "Metro Infrastructure", "Henderson Haulage", "Stoneridge Contracting"];

export type Job = {
  id: string;
  client: string;
  location: string;
  driver: string;
  truck: string;
  status: Status;
  time: string;
  day?: number; // 0..6 Mon..Sun
};

export const jobs: Job[] = [
  { id: "JOB-041", client: "Maple City Council", location: "14 River Rd", driver: "Tom Morrison", truck: "TRK-07", status: "Active", time: "07:00", day: 1 },
  { id: "JOB-042", client: "Brennan Demolition", location: "88 York Ave", driver: "Raja Singh", truck: "TRK-03", status: "Scheduled", time: "09:30", day: 1 },
  { id: "JOB-043", client: "Metro Infrastructure", location: "Site C, North", driver: "Dana Clarke", truck: "TRK-11", status: "Completed", time: "06:00", day: 1 },
  { id: "JOB-044", client: "Henderson Haulage", location: "Depot 4", driver: "Kenji Park", truck: "EQ-02", status: "Scheduled", time: "08:00", day: 2 },
  { id: "JOB-045", client: "Stoneridge Contracting", location: "Lot 12, East", driver: "Abby Walsh", truck: "TRL-01", status: "Active", time: "07:30", day: 2 },
  { id: "JOB-046", client: "Maple City Council", location: "44 Pine St", driver: "Marcus Bell", truck: "TRK-03", status: "Delayed", time: "10:15", day: 3 },
  { id: "JOB-047", client: "Brennan Demolition", location: "11 Harbor Way", driver: "Tom Morrison", truck: "TRK-07", status: "Scheduled", time: "07:00", day: 4 },
  { id: "JOB-048", client: "Metro Infrastructure", location: "Junction B", driver: "Dana Clarke", truck: "TRK-11", status: "Scheduled", time: "06:45", day: 5 },
];

export type WorkOrder = {
  id: string; job: string; client: string; driver: string; submitted: string; status: "Pending" | "Approved" | "Rejected";
  workPerformed: string; loadType: string; weight: string; dumpSite: string; location: string;
};

export const workOrders: WorkOrder[] = [
  { id: "WO-115", job: "JOB-039", client: "Henderson Haulage", driver: "Marcus Bell", submitted: "12 May 2025, 16:08", status: "Approved", workPerformed: "Transported 22 tonnes of clean fill to designated site.", loadType: "Clean fill", weight: "22 tonnes", dumpSite: "Hill Road Tip", location: "Depot 4" },
  { id: "WO-116", job: "JOB-040", client: "Stoneridge Contracting", driver: "Abby Walsh", submitted: "13 May 2025, 11:45", status: "Approved", workPerformed: "Delivered and spread road base on access track.", loadType: "Road base", weight: "9 tonnes", dumpSite: "On-site spread", location: "Lot 12, East" },
  { id: "WO-117", job: "JOB-043", client: "Metro Infrastructure", driver: "Dana Clarke", submitted: "14 May 2025, 12:12", status: "Rejected", workPerformed: "Site visit only — client postponed work.", loadType: "N/A", weight: "0 tonnes", dumpSite: "N/A", location: "Site C, North" },
  { id: "WO-118", job: "JOB-041", client: "Maple City Council", driver: "Tom Morrison", submitted: "14 May 2025, 14:32", status: "Pending", workPerformed: "Excavated and removed 14 tonnes of mixed fill from rear lot. Site left clean.", loadType: "Mixed fill", weight: "14 tonnes", dumpSite: "Greenfield Tip", location: "14 River Rd" },
  { id: "WO-119", job: "JOB-042", client: "Brennan Demolition", driver: "Raja Singh", submitted: "14 May 2025, 15:01", status: "Pending", workPerformed: "Removed broken concrete panels.", loadType: "Concrete", weight: "11 tonnes", dumpSite: "Westside Recycling", location: "88 York Ave" },
  { id: "WO-120", job: "JOB-045", client: "Stoneridge Contracting", driver: "Abby Walsh", submitted: "14 May 2025, 15:48", status: "Pending", workPerformed: "Hauled green waste from yard clearance.", loadType: "Green waste", weight: "6 tonnes", dumpSite: "Composting Centre", location: "Lot 12, East" },
];

export const activityFeed = [
  { time: "08:42", text: "Tom Morrison submitted start-of-day form", type: "positive" as const },
  { time: "08:51", text: "TRK-07 departed depot (GPS confirmed)", type: "positive" as const },
  { time: "09:05", text: "Work order WO-118 submitted, awaiting approval", type: "pending" as const },
  { time: "09:20", text: "Raja Singh clocked in", type: "positive" as const },
  { time: "09:35", text: "Tool checklist flagged: missing item on TRK-03", type: "flag" as const },
  { time: "10:01", text: "JOB-043 marked complete by D. Clarke", type: "positive" as const },
  { time: "10:22", text: "WO-119 submitted by Raja Singh", type: "pending" as const },
  { time: "10:48", text: "TRK-14 brought in for maintenance by Jamie", type: "pending" as const },
];

export const mechanicWorkOrders = [
  { vehicle: "TRK-14 — Isuzu FXZ", issue: "Brake pad wear on rear axle, replace and bleed lines", reportedBy: "Tom Morrison", priority: "High" as const },
  { vehicle: "EQ-02 — CAT 320", issue: "Hydraulic seep at boom cylinder, inspect and reseal", reportedBy: "Kenji Park", priority: "Medium" as const },
];

export const purchaseRequests = [
  { item: "Brake pads — Bendix HD set", cost: 480, date: "10 May 2025", status: "Approved" as const },
  { item: "Hydraulic seal kit — CAT 320", cost: 215, date: "12 May 2025", status: "Pending" as const },
  { item: "Air filter pack (x6)", cost: 132, date: "13 May 2025", status: "Rejected" as const },
];

export const toolChecklist = [
  { name: "Safety cones (4x)", ok: true },
  { name: "Hi-vis vests (2x)", ok: true },
  { name: "First aid kit", ok: true },
  { name: "Fire extinguisher", ok: true },
  { name: "Ground mat", ok: true },
  { name: "Lashing straps (6x)", ok: false },
  { name: "Tow chain", ok: true },
  { name: "Hand tools kit", ok: true },
];
