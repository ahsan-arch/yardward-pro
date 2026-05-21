export type Coords = { lat: number; lng: number };
export type GpsResult =
  | { ok: true; coords: Coords; accuracy: number; capturedAt: string }
  | { ok: false; reason: "unsupported" | "denied" | "timeout" | "unavailable"; message: string };

const DEFAULT_TIMEOUT = 8000;

export async function captureGps(timeoutMs = DEFAULT_TIMEOUT): Promise<GpsResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return {
      ok: false,
      reason: "unsupported",
      message: "Geolocation not supported on this device.",
    };
  }
  return new Promise<GpsResult>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout", message: "GPS lookup timed out." }),
      timeoutMs,
    );
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          ok: true,
          coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          accuracy: pos.coords.accuracy,
          capturedAt: new Date(pos.timestamp).toISOString(),
        });
      },
      (err) => {
        clearTimeout(timer);
        if (err.code === err.PERMISSION_DENIED)
          resolve({ ok: false, reason: "denied", message: "Location permission denied." });
        else if (err.code === err.TIMEOUT)
          resolve({ ok: false, reason: "timeout", message: "GPS lookup timed out." });
        else
          resolve({
            ok: false,
            reason: "unavailable",
            message: err.message || "Location unavailable.",
          });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function formatCoords(c: Coords | null | undefined): string {
  if (!c) return "—";
  return `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
}
