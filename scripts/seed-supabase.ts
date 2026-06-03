// =============================================================================
// One-shot seed: pushes the mockData.ts seed into the live Supabase project.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/seed-supabase.ts
//
// Idempotent for the most part — driver/mechanic auth users are created
// with `email_confirm: true` and skipped if they already exist; other
// inserts use upsert by primary key. Safe to re-run.
// =============================================================================
import { createClient } from "@supabase/supabase-js";
import * as seed from "../src/data/mockData";
import type { Database } from "../src/lib/database.types";

const SUPABASE_URL = "https://pbyeatgjnrhvfnfiublj.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY env var is required.");
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Deterministic UUIDs for the seeded users so re-runs don't duplicate rows.
const DRIVER_UUIDS: Record<string, string> = {
  "D-01": "11111111-1111-1111-1111-000000000001",
  "D-02": "11111111-1111-1111-1111-000000000002",
  "D-03": "11111111-1111-1111-1111-000000000003",
  "D-04": "11111111-1111-1111-1111-000000000004",
  "D-05": "11111111-1111-1111-1111-000000000005",
  "D-06": "11111111-1111-1111-1111-000000000006",
};
const MECHANIC_UUIDS: Record<string, string> = {
  "M-01": "22222222-2222-2222-2222-000000000001",
  "M-02": "22222222-2222-2222-2222-000000000002",
};
const ADMIN_UUID = "6fffbf51-581f-4a12-adbc-93ce3fdc41ea"; // from earlier seed migration

function legacyToUuid(legacyId: string | null): string | null {
  if (!legacyId) return null;
  return DRIVER_UUIDS[legacyId] ?? MECHANIC_UUIDS[legacyId] ?? legacyId;
}

// Parse mock date strings into ISO. Returns null for non-parseable strings
// (like "120,000 km" which the mock uses for nextServiceDue).
function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (m) {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const idx = months.indexOf(m[2].slice(0, 3));
    if (idx >= 0) {
      return `${m[3]}-${String(idx + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
  }
  return null;
}

// Throws if a Supabase response carries an error. Used to fail loud.
function check<T extends { error: { message: string } | null }>(label: string, res: T): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return res;
}

async function ensureAuthUser(opts: {
  uuid: string;
  email: string;
  name: string;
  role: "driver" | "mechanic";
}) {
  const { data: existing } = await admin.auth.admin.getUserById(opts.uuid);
  if (existing?.user) {
    return;
  }
  const { error } = await admin.auth.admin.createUser({
    email: opts.email,
    password: `Seed!${opts.uuid.slice(0, 6)}`,
    email_confirm: true,
    user_metadata: { name: opts.name, role: opts.role },
    id: opts.uuid,
  } as Parameters<typeof admin.auth.admin.createUser>[0] & { id: string });
  if (error && !/already.*registered/i.test(error.message)) {
    throw new Error(`auth user create for ${opts.email}: ${error.message}`);
  }
}

async function seedAll() {
  console.log("==> Creating driver auth users (6)");
  for (const d of seed.drivers) {
    const uuid = DRIVER_UUIDS[d.id];
    if (!uuid) continue;
    await ensureAuthUser({ uuid, email: d.email, name: d.name, role: "driver" });
  }
  console.log("==> Creating mechanic auth users (2)");
  for (const m of seed.mechanics) {
    const uuid = MECHANIC_UUIDS[m.id];
    if (!uuid) continue;
    await ensureAuthUser({ uuid, email: m.email, name: m.name, role: "mechanic" });
  }

  // Update profiles with full names/phones (trigger sets defaults from metadata)
  console.log("==> Upserting profile detail rows");
  for (const d of seed.drivers) {
    const uuid = DRIVER_UUIDS[d.id];
    if (!uuid) continue;
    await admin
      .from("profiles")
      .update({ name: d.name, phone: d.phone, status: d.status })
      .eq("id", uuid);
  }
  for (const m of seed.mechanics) {
    const uuid = MECHANIC_UUIDS[m.id];
    if (!uuid) continue;
    await admin
      .from("profiles")
      .update({ name: m.name, phone: m.phone, status: m.status })
      .eq("id", uuid);
  }

  // Driver/mechanic extension rows
  console.log("==> Upserting drivers + mechanics extension rows");
  await admin.from("drivers").upsert(
    seed.drivers
      .filter((d) => DRIVER_UUIDS[d.id])
      .map((d) => ({
        id: DRIVER_UUIDS[d.id],
        license_number: d.licenseNumber,
        license_expiry: d.licenseExpiry,
        initials: d.initials,
      })),
  );
  await admin.from("mechanics").upsert(
    seed.mechanics
      .filter((m) => MECHANIC_UUIDS[m.id])
      .map((m) => ({
        id: MECHANIC_UUIDS[m.id],
        specialty: m.specialty,
        shop_id: m.shopId,
      })),
  );

  console.log("==> Upserting clients (5)");
  await admin.from("clients").upsert(
    seed.clients.map((c) => ({
      id: c.id,
      name: c.name,
      contact_name: c.contactName,
      email: c.email,
      phone: c.phone,
      billing_address: c.billingAddress,
      rate_table_id: null,
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
    })),
  );

  console.log("==> Upserting rate_tables + line items");
  await admin
    .from("rate_tables")
    .upsert(seed.rateTables.map((rt) => ({ id: rt.id, client_id: rt.clientId })));
  // Now set rate_table_id on clients that have one
  for (const c of seed.clients) {
    if (c.rateTableId) {
      await admin.from("clients").update({ rate_table_id: c.rateTableId }).eq("id", c.id);
    }
  }
  // Wipe + reinsert rate_line_items (no stable id in seed)
  for (const rt of seed.rateTables) {
    await admin.from("rate_line_items").delete().eq("rate_table_id", rt.id);
    if (rt.lineItems.length) {
      await admin.from("rate_line_items").insert(
        rt.lineItems.map((li, i) => ({
          rate_table_id: rt.id,
          description: li.description,
          unit: li.unit,
          rate: li.rate,
          surcharges: li.surcharges,
          position: i,
        })),
      );
    }
  }

  console.log("==> Upserting vehicles (6)");
  check(
    "vehicles upsert",
    await admin.from("vehicles").upsert(
      seed.vehicles.map((v) => ({
        id: v.id,
        name: v.name,
        plate: v.plate,
        year: v.year,
        type: v.type,
        vin: v.vin,
        odometer: v.odometer,
        engine_hours: v.engineHours,
        last_service: parseDate(v.lastService),
        next_service_due: parseDate(v.nextServiceDue),
        driver_id: legacyToUuid(v.driverId),
        geotab_device_id: v.geotabDeviceId,
        status: v.status,
      })),
    ),
  );

  // Reset drivers.vehicle_assignment_id now that vehicles exist
  for (const d of seed.drivers) {
    const uuid = DRIVER_UUIDS[d.id];
    if (!uuid) continue;
    await admin
      .from("drivers")
      .update({ vehicle_assignment_id: d.vehicleAssignmentId })
      .eq("id", uuid);
  }

  console.log("==> Upserting tools, maintenance, fuel");
  if (seed.tools.length)
    check(
      "tools",
      await admin.from("tools").upsert(
        seed.tools.map((t) => ({
          id: t.id,
          name: t.name,
          condition: t.condition,
          vehicle_id: t.vehicleId,
        })),
      ),
    );
  if (seed.maintenanceLogs.length)
    check(
      "maintenance_logs",
      await admin.from("maintenance_logs").upsert(
        seed.maintenanceLogs
          .filter((m) => parseDate(m.date))
          .map((m) => ({
            id: m.id,
            vehicle_id: m.vehicleId,
            type: m.type,
            performed_by: m.performedBy,
            date: parseDate(m.date)!,
            mileage: m.mileage,
            cost: m.cost,
            notes: m.notes,
            attachments: m.attachments,
          })),
      ),
    );
  if (seed.fuelLogs.length)
    check(
      "fuel_logs",
      await admin.from("fuel_logs").upsert(
        seed.fuelLogs
          .filter((f) => parseDate(f.date))
          .map((f) => ({
            id: f.id,
            vehicle_id: f.vehicleId,
            date: parseDate(f.date)!,
            gallons: f.gallons,
            cost: f.cost,
            location: f.location,
            driver_id: legacyToUuid(f.driverId),
          })),
      ),
    );

  console.log("==> Upserting jobs");
  check(
    "jobs",
    await admin.from("jobs").upsert(
      seed.jobs.map((j) => ({
        id: j.id,
        client_id: j.clientId,
        location_address: j.location.address,
        location_lat: j.location.lat,
        location_lng: j.location.lng,
        scheduled_at: j.scheduledAt,
        duration_min: j.durationMin,
        driver_id: legacyToUuid(j.driverId),
        vehicle_id: j.vehicleId,
        status: j.status,
        notes: j.notes,
        created_by: ADMIN_UUID,
      })),
    ),
  );

  console.log("==> Upserting work_orders");
  const jobIds = new Set(seed.jobs.map((j) => j.id));
  const skippedWOs = seed.workOrders.filter((w) => !jobIds.has(w.jobId)).map((w) => w.id);
  if (skippedWOs.length) console.log("    (skipping WOs with missing jobs:", skippedWOs.join(", "), ")");
  check(
    "work_orders",
    await admin.from("work_orders").upsert(
      seed.workOrders.filter((w) => jobIds.has(w.jobId)).map((w) => ({
        id: w.id,
        job_id: w.jobId,
        driver_id: legacyToUuid(w.driverId)!,
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
        submitted_at: w.submittedAt,
        status: w.status,
        approved_by: w.approvedBy ? ADMIN_UUID : null,
        approved_at: w.approvedAt,
      })),
    ),
  );

  console.log("==> Upserting invoice_data + line items");
  const woIds = new Set(
    seed.workOrders.filter((w) => jobIds.has(w.jobId)).map((w) => w.id),
  );
  check(
    "invoice_data",
    await admin.from("invoice_data").upsert(
      seed.invoiceData.map((inv) => ({
        id: inv.id,
        // Null out FK if the WO didn't make it in (e.g. WO-115/WO-116 skipped)
        work_order_id: inv.workOrderId && woIds.has(inv.workOrderId) ? inv.workOrderId : null,
        client_id: inv.clientId,
        kind: inv.kind,
        total: inv.total,
        qbo_sync_status: inv.qboSyncStatus,
        qbo_invoice_id: inv.qboInvoiceId,
      })),
    ),
  );
  // Link work orders to invoices
  for (const inv of seed.invoiceData) {
    if (inv.workOrderId) {
      await admin
        .from("work_orders")
        .update({ invoice_data_id: inv.id })
        .eq("id", inv.workOrderId);
    }
  }
  // Wipe + reinsert invoice_line_items
  for (const inv of seed.invoiceData) {
    await admin.from("invoice_line_items").delete().eq("invoice_data_id", inv.id);
    if (inv.lineItems.length) {
      await admin.from("invoice_line_items").insert(
        inv.lineItems.map((li, i) => ({
          invoice_data_id: inv.id,
          description: li.description,
          qty: li.qty,
          rate: li.rate,
          amount: li.amount,
          position: i,
        })),
      );
    }
  }

  console.log("==> Upserting time_entries");
  await admin.from("time_entries").upsert(
    seed.timeEntries.map((t) => ({
      id: t.id,
      driver_id: legacyToUuid(t.driverId)!,
      clock_in: t.clockIn,
      clock_out: t.clockOut,
      gps_clock_in_lat: t.gpsClockIn?.lat ?? null,
      gps_clock_in_lng: t.gpsClockIn?.lng ?? null,
      gps_clock_out_lat: t.gpsClockOut?.lat ?? null,
      gps_clock_out_lng: t.gpsClockOut?.lng ?? null,
      vehicle_movement_correlation: t.vehicleMovementCorrelation,
      flagged: t.flagged,
      flag_reason: t.flagReason,
    })),
  );

  console.log("==> Upserting purchase_requests + inventory");
  if (seed.purchaseRequests.length)
    await admin.from("purchase_requests").upsert(
      seed.purchaseRequests.map((pr) => ({
        id: pr.id,
        mechanic_id: legacyToUuid(pr.mechanicId)!,
        item: pr.item,
        reason: pr.reason,
        estimated_cost: pr.estimatedCost,
        urgency: pr.urgency,
        inventory_checked_at: pr.inventoryCheckedAt,
        status: pr.status,
        approved_by: pr.approvedBy ? ADMIN_UUID : null,
        supplier_id: pr.supplierId,
      })),
    );
  if (seed.inventoryItems.length)
    await admin.from("inventory_items").upsert(
      seed.inventoryItems.map((i) => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        qty_on_hand: i.qtyOnHand,
        qty_reserved: i.qtyReserved,
        reorder_point: i.reorderPoint,
        supplier_id: i.supplierId,
        last_restocked: i.lastRestocked,
      })),
    );

  console.log("==> Upserting sms_logs + driver_tokens + notifications");
  if (seed.smsLogs.length)
    check(
      "sms_logs",
      await admin.from("sms_logs").upsert(
        seed.smsLogs.map((s) => ({
          id: s.id,
          driver_id: legacyToUuid(s.driverId),
          job_id: s.jobId,
          body: s.body,
          sent_at: s.sentAt,
          twilio_message_id: s.twilioMessageId,
          delivery_status: s.deliveryStatus,
        })),
      ),
    );
  if (seed.driverTokens.length)
    check(
      "driver_tokens",
      await admin.from("driver_tokens").upsert(
        seed.driverTokens.map((t) => ({
          id: t.id,
          driver_id: legacyToUuid(t.driverId)!,
          token: t.token,
          scoped_to: t.scopedTo,
          expires_at: t.expiresAt,
          used_at: t.usedAt,
        })),
      ),
    );
  if (seed.notifications.length) {
    function mapUserId(id: string): string {
      if (DRIVER_UUIDS[id]) return DRIVER_UUIDS[id];
      if (MECHANIC_UUIDS[id]) return MECHANIC_UUIDS[id];
      return ADMIN_UUID; // unknown / "A-01" admin / etc.
    }
    check(
      "notifications",
      await admin.from("notifications").upsert(
        seed.notifications.map((n) => ({
          id: n.id,
          user_id: mapUserId(n.userId),
          type: n.type,
          body: n.body,
          link: n.link,
          read_at: n.readAt,
        })),
      ),
    );
  }

  console.log("==> Upserting ticket_transactions + replenishments");
  if (seed.ticketTransactions.length)
    check(
      "ticket_transactions",
      await admin.from("ticket_transactions").upsert(
        seed.ticketTransactions.map((t) => ({
          id: t.id,
          client_id: t.clientId,
          kind: t.kind,
          qty: t.qty,
          balance_after: t.balanceAfter,
          occurred_at: t.occurredAt,
          work_order_id: t.workOrderId && woIds.has(t.workOrderId) ? t.workOrderId : null,
          vehicle_id: t.vehicleId,
          dump_site: t.dumpSite,
          reason: t.reason,
        })),
      ),
    );
  if (seed.ticketReplenishments.length)
    check(
      "ticket_replenishments",
      await admin.from("ticket_replenishments").upsert(
        seed.ticketReplenishments.map((r) => ({
          id: r.id,
          client_id: r.clientId,
          invoice_data_id: r.invoiceDataId,
          qty: r.qty,
          amount: r.amount,
          triggered_at: r.triggeredAt,
          auto_billed: r.autoBilled,
          qbo_sync_status: r.qboSyncStatus,
          qbo_invoice_id: r.qboInvoiceId,
        })),
      ),
    );

  console.log("\nSeed complete.");
}

seedAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
