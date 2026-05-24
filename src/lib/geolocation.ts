export type Coords = { lat: number; lng: number };
export type GpsSource = "real" | "fallback";

export type GpsFallback = { lat: number; lng: number; label: string };

export type GpsResult =
  | {
      ok: true;
      coords: Coords;
      accuracy: number;
      capturedAt: string;
      source: GpsSource;
      fallbackLabel?: string;
    }
  | {
      ok: false;
      reason: "unsupported" | "denied" | "timeout" | "unavailable";
      message: string;
    };

const DEFAULT_TIMEOUT = 8000;

export async function captureGps(
  options: { timeoutMs?: number; fallback?: GpsFallback | null } = {},
): Promise<GpsResult> {
  const { timeoutMs = DEFAULT_TIMEOUT, fallback } = options;

  function applyFallback(): GpsResult {
    if (!fallback) {
      return { ok: false, reason: "unavailable", message: "Location unavailable." };
    }
    return {
      ok: true,
      coords: { lat: fallback.lat, lng: fallback.lng },
      accuracy: 0,
      capturedAt: new Date().toISOString(),
      source: "fallback",
      fallbackLabel: fallback.label,
    };
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return applyFallback();
  }

  return new Promise<GpsResult>((resolve) => {
    const timer = setTimeout(() => resolve(applyFallback()), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          ok: true,
          coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          accuracy: pos.coords.accuracy,
          capturedAt: new Date(pos.timestamp).toISOString(),
          source: "real",
        });
      },
      () => {
        clearTimeout(timer);
        resolve(applyFallback());
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function formatCoords(c: Coords | null | undefined): string {
  if (!c) return "—";
  return `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
