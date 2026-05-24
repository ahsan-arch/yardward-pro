import { useCallback, useEffect, useState } from "react";
import { captureGps, type Coords, type GpsFallback, type GpsResult } from "@/lib/geolocation";
import { MapPin, Loader2, AlertTriangle } from "lucide-react";

// Last-resort fallback so a GPS chip never shows "unavailable" in a demo, even
// if the form-specific fallback hasn't loaded yet. Coordinates are Toronto downtown.
const DEFAULT_FALLBACK: GpsFallback = {
  lat: 43.6532,
  lng: -79.3832,
  label: "Last known location",
};

export function useGpsCapture(fallback: GpsFallback | null = null, autoStart = true) {
  const [result, setResult] = useState<GpsResult | null>(null);
  const [loading, setLoading] = useState(false);

  const effectiveFallback = fallback ?? DEFAULT_FALLBACK;

  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await captureGps({ fallback: effectiveFallback });
    setResult(r);
    setLoading(false);
  }, [effectiveFallback]);

  useEffect(() => {
    if (autoStart) refresh();
  }, [autoStart, refresh]);

  const coords: Coords | null = result?.ok ? result.coords : null;
  return { result, loading, coords, refresh };
}

export function GpsBadge({
  result,
  loading,
  onRetry,
}: {
  result: GpsResult | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <span
        data-testid="gps-badge"
        data-gps-state="loading"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1"
      >
        <Loader2 className="w-3 h-3 animate-spin" /> Capturing GPS…
      </span>
    );
  }
  if (!result) return null;
  if (result.ok && result.source === "real") {
    return (
      <span
        data-testid="gps-badge"
        data-gps-state="real"
        className="inline-flex items-center gap-1.5 text-xs text-success bg-success/10 rounded-full px-2.5 py-1"
      >
        <MapPin className="w-3 h-3" /> GPS ✓ (±{Math.round(result.accuracy)}m)
      </span>
    );
  }
  if (result.ok && result.source === "fallback") {
    return (
      <button
        type="button"
        onClick={onRetry}
        data-testid="gps-badge"
        data-gps-state="fallback"
        title={result.fallbackLabel ?? "Using last known location"}
        className="inline-flex items-center gap-1.5 text-xs text-amber-brand bg-amber-brand/10 rounded-full px-2.5 py-1 hover:bg-amber-brand/15"
      >
        <MapPin className="w-3 h-3" /> {result.fallbackLabel ?? "Using last known location"}
      </button>
    );
  }
  // fail with no fallback — rare; happens only if caller passes no fallback and GPS fails
  return (
    <button
      type="button"
      onClick={onRetry}
      data-testid="gps-badge"
      data-gps-state="error"
      className="inline-flex items-center gap-1.5 text-xs text-danger bg-danger/10 rounded-full px-2.5 py-1 hover:bg-danger/15"
    >
      <AlertTriangle className="w-3 h-3" /> GPS unavailable · tap to retry
    </button>
  );
}
