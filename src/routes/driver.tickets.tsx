import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Loader2, AlertTriangle, Ticket } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { useOffline } from "@/contexts/OfflineContext";
import { api } from "@/lib/api";
import { offlineQueue } from "@/lib/offline-queue";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/driver/tickets")({
  // The QR code on a ticket book can include `?client=CL-01` so the driver
  // skips the picker step — useful when the book belongs to one client. The
  // search type is loose because tanstack-router validates on read; an
  // unknown client id falls through to the empty-state picker.
  validateSearch: (s: Record<string, unknown>) => ({
    client: typeof s.client === "string" ? s.client : undefined,
  }),
  head: () => ({ meta: [{ title: "Record ticket use — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { isOnline } = useOffline();
  const { clients, drivers, vehicles } = useData();
  const search = useSearch({ from: "/driver/tickets" });

  // Tickets-enabled clients only — the prepaid flow only makes sense for a
  // client whose admin has flipped the program on. Sorted by name so the
  // picker is alphabetised on first open.
  const eligibleClients = useMemo(
    () =>
      clients
        .filter((c) => c.tickets.enabled)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients],
  );

  // Pre-fill from ?client=ID when the QR included it. Falls back to "" so the
  // picker shows the placeholder until the driver chooses.
  const initialClient = useMemo(() => {
    if (!search.client) return "";
    return eligibleClients.find((c) => c.id === search.client)?.id ?? "";
  }, [search.client, eligibleClients]);

  // Has the URL asked for a client we couldn't resolve to a tickets-enabled
  // entry? We distinguish "search param given but client not eligible" from
  // "no eligible clients at all" so the empty state can explain the right
  // thing. A param the driver didn't ask for (no client in URL) is fine.
  const requestedButNotEligible =
    !!search.client && !eligibleClients.some((c) => c.id === search.client);

  const [clientId, setClientId] = useState<string>(initialClient);
  const [tickets, setTickets] = useState<string>("1");
  const [dumpSite, setDumpSite] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Negative-balance confirmation state. When the pre-check fires we stash the
  // projected balance for the dialog copy; the open flag drives the AlertDialog.
  // We don't need to stash the payload — the form fields don't change between
  // submit and confirm, so we just re-run proceedSubmit() on Confirm.
  const [pendingNegative, setPendingNegative] = useState<{
    qty: number;
    projected: number;
    clientName: string;
  } | null>(null);

  // The driver's assigned vehicle is the default. We still expose a picker so
  // a driver covering two trucks today can override; the vehicleId field is
  // required either way. We pull from the live fleet list (useData().vehicles)
  // rather than treating the driver's assignment as the sole valid id — the
  // RPC validates against the vehicles table and would FK-reject any value
  // that isn't a known vehicle, so the Select needs the full fleet.
  const me = drivers.find((d) => d.id === user.id || d.email === user.email);
  const sortedVehicles = useMemo(
    () =>
      vehicles
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [vehicles],
  );
  const [vehicleId, setVehicleId] = useState<string>(me?.vehicleAssignmentId ?? "");

  // The driver row may not be in `drivers` on first render (DataContext
  // hydrates asynchronously). Once the assignment resolves, pre-fill the
  // vehicle picker so `canSubmit` doesn't require an extra manual selection.
  useEffect(() => {
    if (!vehicleId && me?.vehicleAssignmentId) {
      setVehicleId(me.vehicleAssignmentId);
    }
  }, [vehicleId, me?.vehicleAssignmentId]);

  // FK-safety: the RPC rejects an unknown vehicleId with a "vehicle not found"
  // row.error. We pre-validate here so the submit button is disabled and the
  // driver gets an inline message rather than a server round-trip failure.
  // An empty vehicleId is allowed (the RPC treats it as NULL); only a NON-
  // empty value that isn't in the fleet list is a hard error.
  const vehicleValid =
    vehicleId === "" || vehicles.some((v) => v.id === vehicleId);

  // Track the chosen client so balance + threshold copy stay in sync as the
  // picker changes. Pulled out as a derived value rather than effect-shadowed
  // state to avoid stale-render flicker.
  const chosen = clientId ? clients.find((c) => c.id === clientId) ?? null : null;
  const balance = chosen?.tickets.balance ?? 0;
  const threshold = chosen?.tickets.threshold ?? 0;
  const lowBalance = !!chosen && balance <= threshold;

  // Keep state in sync if the search param resolves later (e.g. clients hydrate
  // from Supabase after first paint).
  useEffect(() => {
    if (initialClient && !clientId) {
      setClientId(initialClient);
    }
  }, [initialClient, clientId]);

  // Clamp the ticket count to [1, 20] on every change so an out-of-band paste
  // can't sneak through. We keep the raw string in state for input UX (so the
  // driver can clear the field while typing) and clamp on submit.
  function clampTickets(raw: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return Math.max(1, Math.min(20, Math.floor(n)));
  }

  const canSubmit =
    !!clientId &&
    !!vehicleId &&
    vehicleValid &&
    !!dumpSite.trim() &&
    !submitting;

  // Actually push the debit through (online RPC or offline queue). Split out
  // from submit() so the negative-balance confirm path can re-enter after the
  // dialog resolves without re-running validation.
  async function proceedSubmit(qty: number) {
    const payload = {
      clientId,
      tickets: qty,
      vehicleId,
      dumpSite: dumpSite.trim(),
      notes: notes.trim() || undefined,
      actorId: user.id,
    };
    setSubmitting(true);
    try {
      if (!isOnline) {
        // Offline path: enqueue and surface an immediate optimistic toast.
        // The local recordTicketTransaction mirror runs server-side via the
        // queue flush, not here — keeping the offline payload pristine
        // ensures the actual debit only lands once.
        await offlineQueue.enqueue({ kind: "ticket-use", payload });
        toast.success("Ticket saved offline — will sync when connection returns");
        nav({ to: "/driver" });
        return;
      }
      const { newBalance } = await api.recordTicketUse(payload);
      toast.success(`Ticket recorded — new balance: ${newBalance}`);
      nav({ to: "/driver" });
    } catch (err) {
      // record_driver_ticket_use intentionally allows negative balances, so
      // there's no insufficient-balance error to catch here — the pre-check
      // above handles that case. Surface whatever the RPC actually returned.
      const raw = err instanceof Error ? err.message : "unknown error";
      toast.error(`Ticket failed: ${raw}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      if (!clientId) toast.error("Pick a client first");
      else if (!vehicleId) toast.error("Vehicle is required");
      else if (!vehicleValid) toast.error("Vehicle ID is not in the fleet — pick from the list");
      else if (!dumpSite.trim()) toast.error("Dump site is required");
      return;
    }
    const qty = clampTickets(tickets);
    // Negative-balance pre-check. The RPC silently allows the debit, so the
    // only place we can warn the driver is here on the client. If the
    // projected balance drops below zero, gate the submit behind an explicit
    // confirm; otherwise fall straight through.
    if (chosen) {
      const projected = chosen.tickets.balance - qty;
      if (projected < 0) {
        setPendingNegative({ qty, projected, clientName: chosen.name });
        return;
      }
    }
    await proceedSubmit(qty);
  }

  // Empty states — render full-page placeholders rather than the form when
  // there is nothing the driver can usefully do. The picker dead-ends if it
  // renders with zero items, and the QR-deep-link case where the requested
  // client isn't tickets-enabled deserves its own message so the driver knows
  // it isn't a bug on their end.
  if (requestedButNotEligible) {
    return (
      <DriverShell>
        <div className="p-4">
          <Link
            to="/driver"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-lg bg-amber-brand/10 text-amber-brand grid place-items-center">
              <Ticket className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold mt-3">
              Client is not enabled for tickets
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              The scanned ticket book is linked to a client that doesn't have the
              prepaid ticket program turned on. Ask admin to enable it.
            </p>
            <Button asChild className="mt-4">
              <Link to="/driver">Back to dashboard</Link>
            </Button>
          </div>
        </div>
      </DriverShell>
    );
  }

  if (eligibleClients.length === 0) {
    return (
      <DriverShell>
        <div className="p-4">
          <Link
            to="/driver"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <div className="mt-10 flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-lg bg-amber-brand/10 text-amber-brand grid place-items-center">
              <Ticket className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold mt-3">
              No clients with prepaid tickets yet
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Contact admin to enable ticket mode for a client.
            </p>
            <Button asChild className="mt-4">
              <Link to="/driver">Back to dashboard</Link>
            </Button>
          </div>
        </div>
      </DriverShell>
    );
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex items-start gap-2">
          <div className="w-10 h-10 rounded-lg bg-amber-brand/10 text-amber-brand grid place-items-center">
            <Ticket className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Record ticket</h1>
            <p className="text-sm text-muted-foreground">
              Debit a prepaid ticket against the client's balance.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <Label>Client</Label>
            <Select value={clientId} onValueChange={setClientId}>
              <SelectTrigger className="h-12 mt-1.5">
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {/* The eligibleClients.length === 0 case is handled by the
                    full-page empty-state above, so the Select is only ever
                    rendered with at least one option. */}
                {eligibleClients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {chosen && (
            <div
              className={cn(
                "rounded-lg border p-3",
                lowBalance
                  ? "border-amber-brand/40 bg-amber-brand/10"
                  : "border-border bg-muted/40",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                  Current balance
                </span>
                {lowBalance && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-brand">
                    <AlertTriangle className="w-3 h-3" /> Low
                  </span>
                )}
              </div>
              <div
                className={cn(
                  "font-mono font-bold text-2xl mt-0.5",
                  lowBalance && "text-amber-brand",
                  balance < 0 && "text-danger",
                )}
              >
                {balance}
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  tickets
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Threshold {threshold}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="tickets-qty">Tickets to record</Label>
            <Input
              id="tickets-qty"
              inputMode="numeric"
              value={tickets}
              onChange={(e) => setTickets(e.target.value)}
              onBlur={() => setTickets(String(clampTickets(tickets)))}
              className="h-12 mt-1.5 font-mono text-base"
              placeholder="1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Min 1, max 20 per submission.
            </p>
          </div>

          <div>
            <Label htmlFor="dump-site">Dump site</Label>
            <Input
              id="dump-site"
              value={dumpSite}
              onChange={(e) => setDumpSite(e.target.value)}
              className="h-12 mt-1.5"
              placeholder="e.g. Industrial Park, North gate"
            />
          </div>

          <div>
            <Label>Vehicle</Label>
            {/* Replaces the previous free-text Input. The RPC validates
                vehicleId against the vehicles table and would FK-reject any
                value the driver typed by hand; sourcing the options from
                useData().vehicles guarantees every choice is FK-safe.
                Defaults to the driver's assignedVehicleId but allows override
                for the cover-shift case where the driver is in a different
                truck today. */}
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger className="h-12 mt-1.5">
                <SelectValue placeholder="Select vehicle" />
              </SelectTrigger>
              <SelectContent>
                {sortedVehicles.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No vehicles in the fleet.
                  </div>
                ) : (
                  sortedVehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                      {v.plate ? ` · ${v.plate}` : ""}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {vehicleId !== "" && !vehicleValid && (
              <p className="text-xs text-danger mt-1">
                That vehicle ID isn't in the fleet — pick one from the list.
              </p>
            )}
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Anything billing should know?"
              className="mt-1.5 text-base"
            />
          </div>

          <Button
            type="submit"
            data-testid="record-ticket-submit"
            disabled={!canSubmit}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Recording…
              </>
            ) : (
              "Record ticket"
            )}
          </Button>
        </form>

        {/* Negative-balance confirm. The RPC silently permits the debit, so
            this dialog is the only thing standing between an accidental
            overdraft and the ledger. Confirm proceeds with the original qty;
            Cancel just dismisses and leaves the form intact. */}
        <AlertDialog
          open={pendingNegative !== null}
          onOpenChange={(open) => {
            if (!open) setPendingNegative(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Balance will go negative</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingNegative
                  ? `Recording ${pendingNegative.qty} ticket${pendingNegative.qty === 1 ? "" : "s"} will take ${pendingNegative.clientName} to a balance of ${pendingNegative.projected}. Continue?`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="cancel-negative-balance">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="confirm-negative-balance"
                onClick={() => {
                  const qty = pendingNegative?.qty;
                  setPendingNegative(null);
                  if (qty !== undefined) void proceedSubmit(qty);
                }}
              >
                Confirm
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DriverShell>
  );
}
