import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Wrench,
  Play,
  CheckCircle2,
  Package,
  ClipboardList,
  Undo2,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, MaintenanceWorkOrderError } from "@/lib/api";
import type {
  MaintenanceWorkOrder,
  MaintenanceWorkOrderPart,
  MaintenanceWorkOrderPriority,
} from "@/types/domain";

export const Route = createFileRoute("/mechanic/work-orders")({
  head: () => ({ meta: [{ title: "Workshop work orders — Yardward Pro" }] }),
  component: Page,
});

// Priority order for queue sort. Lex order on the DB string would put
// 'critical' last; this map lets us sort descending by severity.
const PRIORITY_WEIGHT: Record<MaintenanceWorkOrderPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function Page() {
  const { maintenanceWorkOrders, vehicles, inventoryItems, mechanics } = useData();
  const { user } = useAuth();
  const me = user.id;

  // Resolve a mechanic profile id to a display name for the "claimed by X"
  // cells in the queue and sheet. Falls back to a short id suffix when the
  // profile isn't in the seed/mechanics list (e.g. a newly invited mechanic
  // not yet hydrated) so the user still sees *something* identifying.
  function nameForMechanic(profileId: string | null | undefined): string {
    if (!profileId) return "another mechanic";
    const m = mechanics.find((x) => x.id === profileId);
    if (m) return m.name;
    // Short suffix fallback — id may be a UUID or "M-XX". Keep it readable.
    const tail = profileId.length > 8 ? profileId.slice(-6) : profileId;
    return `mechanic ${tail}`;
  }

  const [tab, setTab] = useState<"queue" | "active" | "history">("queue");
  const [openId, setOpenId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);

  // Three filtered views over the shared array. Memoized so a realtime
  // payload triggering a parent re-render doesn't re-sort N times.
  const queueRows = useMemo(
    () =>
      maintenanceWorkOrders
        .filter((w) => w.status === "queued")
        .sort((a, b) => {
          const pa = PRIORITY_WEIGHT[a.priority] ?? 0;
          const pb = PRIORITY_WEIGHT[b.priority] ?? 0;
          if (pa !== pb) return pb - pa;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }),
    [maintenanceWorkOrders],
  );
  const activeRows = useMemo(
    () =>
      maintenanceWorkOrders
        .filter(
          (w) =>
            w.assignedMechanicId === me &&
            (w.status === "claimed" || w.status === "in_progress"),
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    [maintenanceWorkOrders, me],
  );
  const historyRows = useMemo(
    () =>
      maintenanceWorkOrders
        .filter(
          (w) =>
            w.assignedMechanicId === me &&
            (w.status === "completed" || w.status === "cancelled"),
        )
        .sort((a, b) => {
          const ta = a.completedAt ?? a.updatedAt;
          const tb = b.completedAt ?? b.updatedAt;
          return new Date(tb).getTime() - new Date(ta).getTime();
        }),
    [maintenanceWorkOrders, me],
  );

  const open = maintenanceWorkOrders.find((w) => w.id === openId) ?? null;

  function vehicleLabel(vehicleId: string) {
    const v = vehicles.find((x) => x.id === vehicleId);
    return v ? `${v.id} — ${v.name}` : vehicleId;
  }

  async function handleClaim(id: string) {
    setClaiming(id);
    try {
      await api.claimMaintenanceWorkOrder(id, me);
      toast.success("Work order claimed");
      // Switch to the "My active" tab so the freshly-claimed row is visible.
      // We intentionally do NOT auto-open the sheet here — Radix's Sheet
      // applies aria-hidden to background content while open, which hides the
      // Tabs control from the a11y tree (so getByRole('tab') would miss it
      // in e2e). The mechanic can click the row from the active tab if they
      // want to start work immediately.
      setTab("active");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not claim");
    } finally {
      setClaiming(null);
    }
  }

  return (
    <MechanicShell title="Workshop work orders">
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="queue">Queue ({queueRows.length})</TabsTrigger>
          <TabsTrigger value="active">My active ({activeRows.length})</TabsTrigger>
          <TabsTrigger value="history">History ({historyRows.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <QueueTable
            rows={queueRows}
            vehicleLabel={vehicleLabel}
            onOpen={setOpenId}
            onClaim={handleClaim}
            claimingId={claiming}
            myId={me}
            nameForMechanic={nameForMechanic}
          />
        </TabsContent>
        <TabsContent value="active" className="mt-4">
          <RowTable
            rows={activeRows}
            vehicleLabel={vehicleLabel}
            onOpen={setOpenId}
            emptyText="Nothing currently claimed by you."
          />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <RowTable
            rows={historyRows}
            vehicleLabel={vehicleLabel}
            onOpen={setOpenId}
            emptyText="No completed or cancelled work orders yet."
            showCompletedAt
          />
        </TabsContent>
      </Tabs>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {open && (
            // key on wo.id (NOT wo.updatedAt) so opening a *different* row
            // remounts and resets form state, but realtime updates to the
            // *same* row leave the form intact (the inner useEffect handles
            // the sync vs. preserve-dirty-edits decision).
            <WorkOrderSheet
              key={open.id}
              wo={open}
              myId={me}
              vehicleLabel={vehicleLabel(open.vehicleId)}
              inventoryItems={inventoryItems}
              nameForMechanic={nameForMechanic}
              onClose={() => setOpenId(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </MechanicShell>
  );
}

// ---------------------------------------------------------------------------
// Queue table — claim button per row, disables once status flips off 'queued'
// via realtime so two mechanics can't double-claim.
// ---------------------------------------------------------------------------
function QueueTable({
  rows,
  vehicleLabel,
  onOpen,
  onClaim,
  claimingId,
  myId,
  nameForMechanic,
}: {
  rows: MaintenanceWorkOrder[];
  vehicleLabel: (id: string) => string;
  onOpen: (id: string) => void;
  onClaim: (id: string) => void;
  claimingId: string | null;
  myId: string;
  nameForMechanic: (profileId: string | null | undefined) => string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            {["MWO #", "Vehicle", "Issue", "Priority", "Source", "Action"].map((h) => (
              <th key={h} className="text-left font-medium px-4 py-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const stillQueued = w.status === "queued" && !w.assignedMechanicId;
            return (
              <tr
                key={w.id}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                onClick={() => onOpen(w.id)}
              >
                <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">
                  {w.id}
                </td>
                <td className="px-4 py-3">{vehicleLabel(w.vehicleId)}</td>
                <td className="px-4 py-3 max-w-[28ch] truncate">{w.issueDescription}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={w.priority} />
                </td>
                <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                  {w.reportedFrom.replace("_", " ")}
                </td>
                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  {stillQueued ? (
                    <Button
                      size="sm"
                      data-testid={`claim-mwo-${w.id}`}
                      className="h-7 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                      disabled={claimingId === w.id}
                      onClick={() => onClaim(w.id)}
                    >
                      {claimingId === w.id ? "Claiming…" : "Claim"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {w.assignedMechanicId === myId
                        ? "Claimed by you"
                        : `Claimed by ${nameForMechanic(w.assignedMechanicId)}`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                Queue is empty — nothing waiting for a mechanic.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic row table — active + history share the same shape. History adds
// a completed-at column so the mechanic can scan their recent work.
// ---------------------------------------------------------------------------
function RowTable({
  rows,
  vehicleLabel,
  onOpen,
  emptyText,
  showCompletedAt = false,
}: {
  rows: MaintenanceWorkOrder[];
  vehicleLabel: (id: string) => string;
  onOpen: (id: string) => void;
  emptyText: string;
  showCompletedAt?: boolean;
}) {
  const headers = showCompletedAt
    ? ["MWO #", "Vehicle", "Issue", "Status", "Completed"]
    : ["MWO #", "Vehicle", "Issue", "Priority", "Status"];
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            {headers.map((h) => (
              <th key={h} className="text-left font-medium px-4 py-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr
              key={w.id}
              className="border-t border-border hover:bg-muted/30 cursor-pointer"
              onClick={() => onOpen(w.id)}
            >
              <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">
                {w.id}
              </td>
              <td className="px-4 py-3">{vehicleLabel(w.vehicleId)}</td>
              <td className="px-4 py-3 max-w-[32ch] truncate">{w.issueDescription}</td>
              {showCompletedAt ? (
                <>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {w.completedAt
                      ? new Date(w.completedAt).toLocaleString()
                      : "—"}
                  </td>
                </>
              ) : (
                <>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.priority} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={w.status} />
                  </td>
                </>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={headers.length}
                className="px-4 py-10 text-center text-sm text-muted-foreground"
              >
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet — vehicle/issue/source info + action buttons gated on current status.
// Edit form for in_progress: laborHours / laborNotes / partsUsed / finalCost /
// completionNotes. Releases back to queue from the 'claimed' state only.
// ---------------------------------------------------------------------------
function WorkOrderSheet({
  wo,
  myId,
  vehicleLabel,
  inventoryItems,
  nameForMechanic,
  onClose,
}: {
  wo: MaintenanceWorkOrder;
  myId: string;
  vehicleLabel: string;
  inventoryItems: { id: string; name: string; sku: string }[];
  nameForMechanic: (profileId: string | null | undefined) => string;
  onClose: () => void;
}) {
  const owns = wo.assignedMechanicId === myId;
  const [busy, setBusy] = useState(false);
  // Editable form state for in_progress rows. Initialized from the row so
  // an admin/mechanic can reopen and continue editing partial work.
  const [laborHours, setLaborHours] = useState(String(wo.laborHours ?? 0));
  const [laborNotes, setLaborNotes] = useState(wo.laborNotes ?? "");
  const [finalCost, setFinalCost] = useState(
    wo.finalCost != null ? String(wo.finalCost) : "",
  );
  const [completionNotes, setCompletionNotes] = useState(wo.completionNotes ?? "");
  const [parts, setParts] = useState<MaintenanceWorkOrderPart[]>(wo.partsUsed);
  const [pickerItemId, setPickerItemId] = useState<string>("");
  const [pickerQty, setPickerQty] = useState("1");

  // Tracks whether the user has touched the form. Drives the realtime sync
  // policy: clean form silently re-syncs from a newer wo; dirty form keeps
  // the user's edits and shows a banner offering an explicit Discard.
  const [isDirty, setIsDirty] = useState(false);
  // Banner state for "row updated externally" — shown on realtime updatedAt
  // changes while the form has unsaved edits, and on reassignment.
  const [externalUpdate, setExternalUpdate] = useState<null | "edited" | "reassigned">(
    null,
  );
  // Last seen updatedAt — compared against the incoming wo.updatedAt in the
  // sync effect so we only react to real changes (not to React re-renders
  // that happen to pass the same row reference).
  const lastUpdatedAtRef = useRef(wo.updatedAt);
  // Latched assignee at the moment the sheet mounted. The reassignment
  // effect compares wo.assignedMechanicId against THIS, not against myId
  // directly, so opening a row that's already someone else's (e.g. an admin
  // peeking at another mechanic's WO) doesn't misfire the "reassigned"
  // toast + auto-close on first render. The toast only fires when the
  // assignee transitions FROM owning the row (initial === myId) TO not
  // owning it (current !== myId) — i.e. a real mid-session reassignment.
  const initialAssigneeRef = useRef(wo.assignedMechanicId);

  // Wrap setters so any user edit flips isDirty. Keeping this as a tiny
  // helper avoids forgetting to flip the flag on a new field added later.
  function makeDirty<T extends (v: string) => void>(setter: T): T {
    return ((v: string) => {
      setIsDirty(true);
      setter(v);
    }) as T;
  }
  const onLaborHoursChange = makeDirty(setLaborHours);
  const onLaborNotesChange = makeDirty(setLaborNotes);
  const onFinalCostChange = makeDirty(setFinalCost);
  const onCompletionNotesChange = makeDirty(setCompletionNotes);

  function resetFromWo(next: MaintenanceWorkOrder) {
    setLaborHours(String(next.laborHours ?? 0));
    setLaborNotes(next.laborNotes ?? "");
    setFinalCost(next.finalCost != null ? String(next.finalCost) : "");
    setCompletionNotes(next.completionNotes ?? "");
    setParts(next.partsUsed);
    setIsDirty(false);
    setExternalUpdate(null);
  }

  // Realtime sync: when wo.updatedAt changes (a Supabase realtime tick
  // landed for this row while the sheet was open), either silently refresh
  // the form (clean) or surface a banner that preserves user edits (dirty).
  useEffect(() => {
    if (wo.updatedAt === lastUpdatedAtRef.current) return;
    lastUpdatedAtRef.current = wo.updatedAt;
    if (!isDirty) {
      resetFromWo(wo);
    } else {
      // Dirty edits — don't clobber them. Banner lets the user explicitly
      // discard if they decide the new server state should win.
      setExternalUpdate("edited");
    }
    // We intentionally omit isDirty from deps: we only want this to fire
    // when the row itself changes from realtime, not when the user starts
    // editing (which would otherwise immediately reset the flag).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo.updatedAt]);

  // Reassignment watch: only fire when the assignee TRANSITIONS away from us
  // mid-session. The previous heuristic — `wo.assignedMechanicId && !== myId`
  // — fired on the very first render whenever the sheet opened on a row that
  // was already owned by someone else (e.g. an admin/auditor reviewing
  // another mechanic's active WO from the queue), producing a false
  // "reassigned" toast and an unwanted auto-close. We now latch the assignee
  // at mount time in initialAssigneeRef and compare against THAT: the toast
  // fires only when initial === myId (we owned it on open) AND current !== myId
  // (we don't anymore). Mount-time mismatches are no-ops.
  useEffect(() => {
    // Re-arm the latch on the FORWARD transition: if we weren't the owner at
    // open (or whenever we last re-armed) and we ARE now, treat this moment
    // as the new "we own it" baseline. Without this re-arm, the
    // open-on-queued-then-claim-inside-sheet flow keeps initialAssigneeRef
    // at null forever and silently misses any subsequent reassignment.
    if (
      initialAssigneeRef.current !== myId &&
      wo.assignedMechanicId === myId
    ) {
      initialAssigneeRef.current = myId;
      return;
    }
    if (
      initialAssigneeRef.current === myId &&
      wo.assignedMechanicId !== myId
    ) {
      setExternalUpdate("reassigned");
      toast.error(
        `This work order was reassigned to ${nameForMechanic(wo.assignedMechanicId)}.`,
      );
      onClose();
    }
    // onClose / nameForMechanic are stable for the lifetime of this sheet;
    // re-running on identity change isn't desirable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wo.assignedMechanicId, myId]);

  function addPart() {
    // Floor to drop fractional qty (a wrench-out can't take half a part);
    // clamp to [1, 50] so a typo of "500" doesn't reserve absurd stock.
    const qty = Math.max(1, Math.min(50, Math.floor(Number(pickerQty) || 1)));
    if (!pickerItemId) {
      toast.error("Pick an item and a positive qty");
      return;
    }
    setIsDirty(true);
    setParts((arr) => {
      // If we've already used this item, sum qty rather than duplicating
      const idx = arr.findIndex((p) => p.inventoryItemId === pickerItemId);
      if (idx >= 0) {
        const copy = arr.slice();
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + qty };
        return copy;
      }
      return [...arr, { inventoryItemId: pickerItemId, qty }];
    });
    setPickerItemId("");
    setPickerQty("1");
  }
  function removePart(itemId: string) {
    setIsDirty(true);
    setParts((arr) => arr.filter((p) => p.inventoryItemId !== itemId));
  }

  // Centralized error toast that special-cases the typed reassigned error so
  // every action button surfaces the same friendly copy + closes the sheet.
  function handleActionError(err: unknown, fallback: string) {
    if (err instanceof MaintenanceWorkOrderError && err.code === "reassigned") {
      toast.error("This work order was reassigned. You no longer have edit access.");
      onClose();
      return;
    }
    toast.error(err instanceof Error ? err.message : fallback);
  }

  async function startWork() {
    setBusy(true);
    try {
      await api.updateMaintenanceWorkOrder(
        wo.id,
        { status: "in_progress", startedAt: new Date().toISOString() },
        myId,
      );
      toast.success("Work started");
    } catch (err) {
      handleActionError(err, "Could not start");
    } finally {
      setBusy(false);
    }
  }
  async function releaseBack() {
    setBusy(true);
    try {
      // Delegate to the SECURITY DEFINER release_maintenance_work_order RPC
      // which atomically sets status='queued', assigned_mechanic_id=NULL,
      // claimed_at=NULL, started_at=NULL. We can't do this via the open-coded
      // UPDATE path because the mechanic UPDATE policy's WITH CHECK clause
      // (`assigned_mechanic_id = auth.uid()`) rejects the NULL transition and
      // surfaces as an RLS error that the old heuristic mis-mapped to a
      // false-positive "reassigned" toast on every Release click.
      await api.releaseMaintenanceWorkOrder(wo.id, myId);
      toast.success("Released back to the queue");
      onClose();
    } catch (err) {
      handleActionError(err, "Could not release");
    } finally {
      setBusy(false);
    }
  }
  async function markComplete() {
    const lh = Number(laborHours);
    if (!Number.isFinite(lh) || lh < 0) {
      toast.error("Labor hours must be a non-negative number");
      return;
    }
    const fc = finalCost.trim() === "" ? null : Number(finalCost);
    if (fc != null && (!Number.isFinite(fc) || fc < 0)) {
      toast.error("Final cost must be a non-negative number");
      return;
    }
    setBusy(true);
    try {
      await api.updateMaintenanceWorkOrder(
        wo.id,
        {
          status: "completed",
          completedAt: new Date().toISOString(),
          laborHours: lh,
          laborNotes,
          partsUsed: parts,
          finalCost: fc,
          completionNotes,
        },
        myId,
      );
      toast.success("Marked complete");
      onClose();
    } catch (err) {
      handleActionError(err, "Could not complete");
    } finally {
      setBusy(false);
    }
  }
  async function saveProgress() {
    const lh = Number(laborHours);
    if (!Number.isFinite(lh) || lh < 0) {
      toast.error("Labor hours must be a non-negative number");
      return;
    }
    const fc = finalCost.trim() === "" ? null : Number(finalCost);
    if (fc != null && (!Number.isFinite(fc) || fc < 0)) {
      toast.error("Final cost must be a non-negative number");
      return;
    }
    setBusy(true);
    try {
      await api.updateMaintenanceWorkOrder(
        wo.id,
        {
          laborHours: lh,
          laborNotes,
          partsUsed: parts,
          finalCost: fc,
          completionNotes,
        },
        myId,
      );
      toast.success("Progress saved");
      // A successful save means the server now matches our form values, so
      // drop the dirty flag — the next realtime tick (which will echo our
      // own update back) should silently sync rather than show the banner.
      setIsDirty(false);
      setExternalUpdate(null);
    } catch (err) {
      handleActionError(err, "Could not save");
    } finally {
      setBusy(false);
    }
  }

  function partLabel(itemId: string) {
    const item = inventoryItems.find((it) => it.id === itemId);
    return item ? `${item.name} (${item.sku})` : itemId;
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <Wrench className="w-4 h-4" />
          <span className="font-mono">{wo.id}</span>
          <StatusBadge status={wo.status} />
        </SheetTitle>
      </SheetHeader>
      <div className="space-y-5 mt-6">
        {externalUpdate === "edited" && (
          // Realtime tick landed while we had unsaved edits — let the user
          // either keep their work (default) or discard and pick up the new
          // server state. Saving will also clear this banner on success.
          <div className="rounded-md border border-amber-brand/40 bg-amber-brand/10 px-3 py-2 text-xs flex items-center gap-2">
            <span className="flex-1">
              Row updated externally — your edits are preserved.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => resetFromWo(wo)}
            >
              Discard
            </Button>
          </div>
        )}
        <Section title="Vehicle">
          <div className="font-medium">{vehicleLabel}</div>
        </Section>
        <Section title="Issue">
          <p className="text-sm whitespace-pre-wrap">{wo.issueDescription}</p>
        </Section>
        <div className="grid grid-cols-2 gap-3">
          <Section title="Priority">
            <StatusBadge status={wo.priority} />
          </Section>
          <Section title="Source">
            <span className="text-sm font-mono">{wo.reportedFrom.replace("_", " ")}</span>
          </Section>
        </div>
        {wo.sourceInspectionId && (
          <Section title="Source inspection">
            <span className="text-xs font-mono text-muted-foreground">
              {wo.sourceInspectionId}
            </span>
          </Section>
        )}

        {/* Editable section visible once work has started so the mechanic can
            record parts/labor as the job progresses. Hidden in 'queued' and
            'claimed' states to keep the surface lean. */}
        {(wo.status === "in_progress" ||
          wo.status === "completed" ||
          wo.status === "cancelled") &&
          owns && (
            <div className="border-t border-border pt-4 space-y-4">
              <Section title="Labor">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Hours</Label>
                    <Input
                      type="number"
                      step="0.25"
                      className="font-mono"
                      value={laborHours}
                      onChange={(e) => onLaborHoursChange(e.target.value)}
                      disabled={wo.status !== "in_progress"}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Final cost ($)</Label>
                    <Input
                      type="number"
                      step="0.01"
                      className="font-mono"
                      value={finalCost}
                      onChange={(e) => onFinalCostChange(e.target.value)}
                      disabled={wo.status !== "in_progress"}
                    />
                  </div>
                </div>
                <Label className="text-xs mt-3 block">Labor notes</Label>
                <Textarea
                  rows={2}
                  value={laborNotes}
                  onChange={(e) => onLaborNotesChange(e.target.value)}
                  disabled={wo.status !== "in_progress"}
                />
              </Section>

              <Section title="Parts used">
                {parts.length === 0 ? (
                  <p className="text-xs font-mono text-muted-foreground mb-2">
                    No parts recorded yet.
                  </p>
                ) : (
                  <ul className="space-y-1 mb-3">
                    {parts.map((p) => (
                      <li
                        key={p.inventoryItemId}
                        className="text-sm flex items-center gap-2 bg-muted/30 rounded px-2 py-1.5"
                      >
                        <Package className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="flex-1">{partLabel(p.inventoryItemId)}</span>
                        <span className="font-mono text-xs">× {p.qty}</span>
                        {wo.status === "in_progress" && (
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-danger"
                            onClick={() => removePart(p.inventoryItemId)}
                            aria-label="Remove part"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {wo.status === "in_progress" && (
                  <div className="flex gap-2 items-end">
                    <div className="flex-1 min-w-0">
                      <Label className="text-xs">Add part</Label>
                      <Select value={pickerItemId} onValueChange={setPickerItemId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Pick inventory item" />
                        </SelectTrigger>
                        <SelectContent>
                          {inventoryItems.map((it) => (
                            <SelectItem key={it.id} value={it.id}>
                              {it.name} ({it.sku})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-20">
                      <Label className="text-xs">Qty</Label>
                      <Input
                        type="number"
                        min="1"
                        className="font-mono"
                        value={pickerQty}
                        onChange={(e) => setPickerQty(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10"
                      onClick={addPart}
                    >
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </Section>

              <Section title="Completion notes">
                <Textarea
                  rows={3}
                  value={completionNotes}
                  onChange={(e) => onCompletionNotesChange(e.target.value)}
                  disabled={wo.status !== "in_progress"}
                />
              </Section>
            </div>
          )}

        {/* Action buttons — gated by the current status. Designed so the
            mechanic has one obvious next-step at any time. */}
        <div className="space-y-2 pt-2 border-t border-border">
          {wo.status === "claimed" && owns && (
            <>
              <Button
                onClick={startWork}
                disabled={busy}
                className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                <Play className="w-4 h-4" /> Start work
              </Button>
              <Button
                onClick={releaseBack}
                disabled={busy}
                variant="outline"
                className="w-full"
              >
                <Undo2 className="w-4 h-4" /> Release back to queue
              </Button>
            </>
          )}
          {wo.status === "in_progress" && owns && (
            <>
              <Button
                onClick={saveProgress}
                disabled={busy}
                variant="outline"
                className="w-full"
              >
                <ClipboardList className="w-4 h-4" /> Save progress
              </Button>
              <Button
                onClick={markComplete}
                disabled={busy}
                className="w-full border-success text-success hover:bg-success/10"
                variant="outline"
              >
                <CheckCircle2 className="w-4 h-4" /> Mark complete
              </Button>
            </>
          )}
          {(wo.status === "queued" || !owns) && wo.status !== "claimed" && (
            <p className="text-xs font-mono text-muted-foreground text-center py-2">
              {wo.status === "queued"
                ? "Claim from the queue tab to take this work order."
                : `Claimed by ${nameForMechanic(wo.assignedMechanicId)}.`}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}
