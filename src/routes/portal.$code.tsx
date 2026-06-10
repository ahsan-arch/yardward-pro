// Public client dump-form portal — Formstack replacement, Phase 1.
//
// Client truck drivers open /portal/<their-access-code> (bookmarked or
// linked from the EHS website). The code is exchanged for the client's
// form context (company name + pre-populated driver/truck dropdowns), and
// submissions go through the client-portal edge function which re-validates
// the code and the required fields server-side.
//
// No login, no shell — this audience is external drivers on phones. Codes
// are per-employee and revocable from Admin → Clients → Portal access.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { BrandMark } from "@/components/crm/BrandMark";
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
import { Loader2, CheckCircle2, XCircle, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";

export const Route = createFileRoute("/portal/$code")({
  head: () => ({ meta: [{ title: "Dump form — Engage Hydrovac Services" }] }),
  component: Page,
});

const LOAD_TYPES = [
  "Liquid soil",
  "Dry soil",
  "Slurry",
  "Street sweepings",
  "Sewage waste",
  "Aggregate",
  "Other",
];

type Ctx = { clientName: string; driverNames: string[]; truckNumbers: string[] };

function Page() {
  const { code } = Route.useParams();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const gps = useGpsCapture(null);

  const [driverName, setDriverName] = useState("");
  const [truckNumber, setTruckNumber] = useState("");
  const [loadType, setLoadType] = useState("");
  const [quantity, setQuantity] = useState("");
  const [weight, setWeight] = useState("");
  const [location, setLocation] = useState("");
  const [receivingSite, setReceivingSite] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null); // submission code
  const [ticketsRemaining, setTicketsRemaining] = useState<number | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const r = await api.portalContext(code);
      if (r.ok) setCtx(r);
      else setCtxError(r.reason);
    })();
  }, [code]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!driverName) errs.driverName = "Required";
    if (!truckNumber) errs.truckNumber = "Required";
    if (!loadType) errs.loadType = "Required";
    if (!location.trim()) errs.location = "Required";
    if (!quantity.trim() && !weight.trim()) errs.weight = "Enter a quantity or weight";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setSubmitting(true);
    try {
      const gpsCoords = gps.result?.ok ? gps.result.coords : null;
      const r = await api.portalSubmitDump(code, {
        driverName,
        truckNumber,
        loadType,
        quantity: quantity.trim(),
        weight: weight.trim(),
        location: location.trim(),
        receivingSite: receivingSite.trim(),
        notes: notes.trim(),
        gpsLat: gpsCoords?.lat ?? null,
        gpsLng: gpsCoords?.lng ?? null,
      });
      if (!r.ok) {
        setErr({ form: r.reason });
        return;
      }
      setTicketsRemaining(typeof r.ticketsRemaining === "number" ? r.ticketsRemaining : null);
      setDone(r.submissionCode);
    } finally {
      setSubmitting(false);
    }
  }

  function resetForNext() {
    setDone(null);
    setLoadType("");
    setQuantity("");
    setWeight("");
    setLocation("");
    setReceivingSite("");
    setNotes("");
    setErr({});
    void gps.refresh();
  }

  // ---- Invalid / revoked code ----------------------------------------------
  if (ctxError) {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-6">
        <div className="w-full max-w-md text-center space-y-4">
          <div className="flex justify-center">
            <BrandMark size="lg" />
          </div>
          <XCircle className="w-10 h-10 text-danger mx-auto" />
          <h1 className="text-lg font-semibold">Access code not valid</h1>
          <p className="text-sm text-muted-foreground">{ctxError}</p>
          <p className="text-xs text-muted-foreground">
            Contact Engage Hydrovac Services if you believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-6">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ---- Success screen -------------------------------------------------------
  if (done) {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-6">
        <div className="w-full max-w-md text-center space-y-4">
          <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
          <h1 className="text-xl font-bold">Form submitted</h1>
          <p className="text-sm text-muted-foreground">
            Your confirmation code — quote this at the gate:
          </p>
          <div
            className="font-mono text-lg font-bold bg-muted/50 border border-border rounded-md py-3"
            data-testid="portal-submission-code"
          >
            {done}
          </div>
          {ticketsRemaining != null && (
            <p
              className={cn(
                "text-sm font-medium",
                ticketsRemaining <= 20 ? "text-danger" : "text-muted-foreground",
              )}
              data-testid="portal-tickets-remaining"
            >
              Prepaid dump tickets remaining: {ticketsRemaining}
              {ticketsRemaining <= 20 ? " — time to purchase more" : ""}
            </p>
          )}
          <Button
            onClick={resetForNext}
            className="w-full h-12 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
            data-testid="portal-submit-another"
          >
            Submit another load
          </Button>
        </div>
      </div>
    );
  }

  // ---- The form ---------------------------------------------------------------
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto p-4 pb-10">
        <div className="flex items-center gap-3 py-4">
          <BrandMark size="lg" />
          <div>
            <div className="font-bold leading-tight">Dump / Load Form</div>
            <div className="text-xs text-muted-foreground">{ctx.clientName}</div>
          </div>
          <div className="ml-auto">
            <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Driver name *</Label>
            {ctx.driverNames.length > 0 ? (
              <Select value={driverName} onValueChange={setDriverName}>
                <SelectTrigger
                  className={cn("h-12 mt-1.5", err.driverName && "border-danger")}
                  data-testid="portal-driver-name"
                >
                  <SelectValue placeholder="Select your name" />
                </SelectTrigger>
                <SelectContent>
                  {ctx.driverNames.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder="Your full name"
                className={cn("h-12 mt-1.5", err.driverName && "border-danger")}
                data-testid="portal-driver-name-input"
              />
            )}
            {err.driverName && <p className="text-xs text-danger mt-1">{err.driverName}</p>}
          </div>

          <div>
            <Label>Truck number *</Label>
            {ctx.truckNumbers.length > 0 ? (
              <Select value={truckNumber} onValueChange={setTruckNumber}>
                <SelectTrigger
                  className={cn("h-12 mt-1.5", err.truckNumber && "border-danger")}
                  data-testid="portal-truck-number"
                >
                  <SelectValue placeholder="Select truck" />
                </SelectTrigger>
                <SelectContent>
                  {ctx.truckNumbers.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={truckNumber}
                onChange={(e) => setTruckNumber(e.target.value)}
                placeholder="Truck #"
                className={cn("h-12 mt-1.5", err.truckNumber && "border-danger")}
                data-testid="portal-truck-number-input"
              />
            )}
            {err.truckNumber && <p className="text-xs text-danger mt-1">{err.truckNumber}</p>}
          </div>

          <div>
            <Label>Load type *</Label>
            <Select value={loadType} onValueChange={setLoadType}>
              <SelectTrigger
                className={cn("h-12 mt-1.5", err.loadType && "border-danger")}
                data-testid="portal-load-type"
              >
                <SelectValue placeholder="What's in the load?" />
              </SelectTrigger>
              <SelectContent>
                {LOAD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {err.loadType && <p className="text-xs text-danger mt-1">{err.loadType}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 8 m³"
                className="h-12 mt-1.5"
                data-testid="portal-quantity"
              />
            </div>
            <div>
              <Label>Weight</Label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="e.g. 12.4 t"
                className={cn("h-12 mt-1.5", err.weight && "border-danger")}
                data-testid="portal-weight"
              />
            </div>
          </div>
          {err.weight && <p className="text-xs text-danger -mt-2">{err.weight}</p>}

          <div>
            <Label>Loading location *</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Site address where the load came from"
              className={cn("h-12 mt-1.5", err.location && "border-danger")}
              data-testid="portal-location"
            />
            {err.location && <p className="text-xs text-danger mt-1">{err.location}</p>}
          </div>

          <div>
            <Label>Receiving site</Label>
            <Input
              value={receivingSite}
              onChange={(e) => setReceivingSite(e.target.value)}
              placeholder="Where the load is going (optional)"
              className="h-12 mt-1.5"
              data-testid="portal-receiving-site"
            />
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional"
              className="mt-1.5"
            />
          </div>

          {err.form && (
            <p className="text-sm text-danger" data-testid="portal-form-error">
              {err.form}
            </p>
          )}

          <Button
            type="submit"
            disabled={submitting}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
            data-testid="portal-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <Truck className="w-5 h-5" /> Submit form
              </>
            )}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            GPS location and time are recorded with this submission.
          </p>
        </form>
      </div>
    </div>
  );
}
