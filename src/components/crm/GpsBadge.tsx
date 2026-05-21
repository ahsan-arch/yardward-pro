import { useEffect, useState } from "react";
import { captureGps, type Coords, type GpsResult } from "@/lib/geolocation";
import { MapPin, Loader2, AlertTriangle } from "lucide-react";

export function useGpsCapture(autoStart = true) {
  const [result, setResult] = useState<GpsResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    const r = await captureGps();
    setResult(r);
    setLoading(false);
  }

  useEffect(() => {
    if (autoStart) refresh();
  }, [autoStart]);

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
  if (loading)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1">
        <Loader2 className="w-3 h-3 animate-spin" /> Capturing GPS…
      </span>
    );
  if (!result) return null;
  if (result.ok)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-success bg-success/10 rounded-full px-2.5 py-1">
        <MapPin className="w-3 h-3" /> GPS ✓ (±{Math.round(result.accuracy)}m)
      </span>
    );
  return (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex items-center gap-1.5 text-xs text-danger bg-danger/10 rounded-full px-2.5 py-1 hover:bg-danger/15"
    >
      <AlertTriangle className="w-3 h-3" />{" "}
      {result.reason === "denied" ? "GPS denied" : "GPS unavailable"} · tap to retry
    </button>
  );
}
