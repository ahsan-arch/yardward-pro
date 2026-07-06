import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L, { type DivIcon } from "leaflet";
import { AlertTriangle, Locate, RefreshCw, Truck } from "lucide-react";
import { api } from "@/lib/api";
import { driverById, geotabCoordsForVehicle } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { reportErrorToServer } from "@/lib/error-capture";
import type { Vehicle } from "@/types/domain";
import { cn } from "@/lib/utils";

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DEFAULT_CENTER: [number, number] = [43.6532, -79.3832]; // Toronto downtown
const DEFAULT_ZOOM = 12;

type LiveCoord = { lat: number; lng: number; capturedAt: string };
type LiveCoords = Record<string, LiveCoord>;

const STATUS_COLOR: Record<Vehicle["status"], string> = {
  operational: "#10b981", // success green
  maintenance: "#f59e0b", // amber
  "out-of-service": "#6b7280", // gray
};

const MOVING_COLOR = "#10b981"; // green
const STOPPED_COLOR = "#6b7280"; // gray

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Decide whether a vehicle is currently moving. Prefer the `isDriving` flag
 * written by the Geotab cron; fall back to a speed threshold when it's null
 * (and finally to `false` when we have no telematics at all).
 */
export function isVehicleMoving(vehicle: Vehicle): boolean {
  if (vehicle.isDriving === true) return true;
  if (vehicle.isDriving === false) return false;
  if (typeof vehicle.speedKmh === "number") return vehicle.speedKmh > 5;
  return false;
}

/** Stale = we haven't seen a Geotab ping in over 30 minutes, or never. */
export function isVehicleStale(vehicle: Vehicle): boolean {
  const ts = vehicle.lastSeenAt ?? vehicle.locationUpdatedAt;
  if (!ts) return true; // never reported → most-stale
  return Date.now() - new Date(ts).getTime() > STALE_THRESHOLD_MS;
}

function buildIcon(vehicle: Vehicle): DivIcon {
  const moving = isVehicleMoving(vehicle);
  const color = moving ? MOVING_COLOR : STOPPED_COLOR;
  // Moving pins get a pulsing translucent ring; stopped pins are solid.
  const pulseRing = moving
    ? `<div style="
         position:absolute;inset:-6px;border-radius:50%;
         border:2px solid ${color};opacity:0.7;
         animation:vehicle-pulse 1.6s ease-out infinite;
         pointer-events:none;
       "></div>`
    : "";
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);">
      <div style="position:relative;">
        ${pulseRing}
        <div style="
          position:relative;
          width:34px;height:34px;border-radius:50%;
          background:${color};border:3px solid white;
          box-shadow:0 2px 6px rgba(0,0,0,0.35);
          display:flex;align-items:center;justify-content:center;
          color:white;font-weight:700;font-size:10px;font-family:'DM Mono',ui-monospace,monospace;
          white-space:nowrap;
        ">${vehicle.id.replace(/-/g, "")}</div>
      </div>
      <div style="
        width:0;height:0;
        border-left:6px solid transparent;border-right:6px solid transparent;
        border-top:8px solid ${color};
        margin-top:-2px;
      "></div>
    </div>
  `;
  return L.divIcon({
    html,
    className: "", // strip default leaflet styling
    iconSize: [34, 42],
    iconAnchor: [17, 42],
    popupAnchor: [0, -42],
  });
}

export function relativeTime(iso: string) {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} h ago`;
  return `${Math.round(diffSec / 86400)} d ago`;
}

/** Re-fit map bounds to the current pin set whenever it changes. */
function FitToPins({ coords }: { coords: LiveCoord[] }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length === 0) return;
    // Wrap the fit in try/catch: during a navigation-away teardown the pane can
    // be half-removed, and Leaflet reads _leaflet_pos off it and throws. That
    // error is benign (the user is leaving the page) but would otherwise reach
    // the app error boundary and render a full-page crash.
    try {
      // animate:false on the auto-fit is deliberate. This effect runs on mount
      // AND on every 30/60s refresh; an animated pan schedules a
      // requestAnimationFrame that can outlive a navigation-away teardown and
      // read _leaflet_pos off a removed pane. A non-animated fit is synchronous
      // (no orphan frame) and reads as an instant snap-to-fit, which is fine
      // for a passively-refreshing fleet map. (User-initiated focus still
      // animates — see FocusOnVehicle.)
      if (coords.length === 1) {
        map.setView([coords[0].lat, coords[0].lng], 14, { animate: false });
      } else {
        const bounds = L.latLngBounds(coords.map((c) => [c.lat, c.lng] as [number, number]));
        map.fitBounds(bounds, { padding: [40, 40], animate: false });
      }
    } catch {
      /* map torn down mid-update — safe to ignore */
    }
    // Cancel any in-flight pan/zoom animation before this effect re-runs or the
    // map is torn down. Child effect cleanups run before MapContainer's
    // map.remove(), so the animation is stopped while the map is still alive —
    // otherwise an orphaned animation frame reads _leaflet_pos off a removed
    // pane and throws.
    return () => {
      try {
        map.stop();
      } catch {
        /* already removed */
      }
    };
  }, [JSON.stringify(coords.map((c) => [c.lat, c.lng])), map]);
  return null;
}

/** Center+zoom on one vehicle id when focusVehicleId changes. */
function FocusOnVehicle({
  focusVehicleId,
  coords,
}: {
  focusVehicleId: string | null | undefined;
  coords: LiveCoords;
}) {
  const map = useMap();
  useEffect(() => {
    if (!focusVehicleId) return;
    const c = coords[focusVehicleId];
    if (!c) return;
    try {
      map.flyTo([c.lat, c.lng], 15, { animate: true, duration: 0.6 });
    } catch {
      /* map torn down mid-update — safe to ignore */
    }
    // Cancel the in-flight flyTo on cleanup/unmount so its animation frame
    // never touches a removed map pane (_leaflet_pos undefined crash).
    return () => {
      try {
        map.stop();
      } catch {
        /* already removed */
      }
    };
  }, [focusVehicleId, coords, map]);
  return null;
}

/**
 * Map-only error boundary. Contains any Leaflet render/teardown error to the
 * map panel instead of letting it bubble to the app-level ErrorBoundary and
 * blank the whole page. The "_leaflet_pos" teardown race is benign (it fires
 * as the user navigates away), so we recover silently and do NOT report it;
 * any other map error is reported once and shows a small retry card.
 */
class MapBoundary extends Component<
  { children: ReactNode; height: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  // Bounds the silent auto-recovery so a (hypothetical) persistent
  // _leaflet_pos throw can't spin render → catch → render forever.
  private recoveries = 0;
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    const benign = /_leaflet_pos/.test(error?.message ?? "");
    if (benign && this.recoveries < 3) {
      // Transient teardown race — drop the error state so the map re-renders
      // cleanly on the next commit rather than sticking on the fallback.
      this.recoveries += 1;
      this.setState({ hasError: false });
      return;
    }
    if (benign) return; // exhausted recoveries: leave the fallback up, don't report
    void reportErrorToServer({
      severity: "error",
      errorCode: "MAP_RENDER",
      message: error?.message || "Map render error",
      stack: error?.stack ?? null,
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{ height: this.props.height }}
          className="grid place-items-center bg-muted text-center p-4"
        >
          <div className="text-xs text-muted-foreground">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-amber-brand" />
            Map couldn’t render.
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="block mx-auto mt-2 text-amber-brand hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export type VehicleMapProps = {
  vehicles: Vehicle[];
  height?: string;
  autoRefreshMs?: number;
  interactive?: boolean;
  showSidebar?: boolean;
  /** Show a "X moving · Y stopped · Z stale" bar above the map header. */
  showStatsBar?: boolean;
  focusVehicleId?: string | null;
  onVehicleClick?: (id: string) => void;
  className?: string;
};

export type VehicleFleetStats = {
  moving: number;
  stopped: number;
  stale: number;
};

/** Summarize a vehicle list for the stats bar. Exported for reuse + tests. */
export function computeFleetStats(vehicles: Vehicle[]): VehicleFleetStats {
  let moving = 0;
  let stopped = 0;
  let stale = 0;
  for (const v of vehicles) {
    if (isVehicleStale(v)) stale += 1;
    if (isVehicleMoving(v)) moving += 1;
    else stopped += 1;
  }
  return { moving, stopped, stale };
}

export function VehicleMap({
  vehicles,
  height = "600px",
  autoRefreshMs = 30_000,
  interactive = true,
  showSidebar = false,
  showStatsBar = false,
  focusVehicleId = null,
  onVehicleClick,
  className,
}: VehicleMapProps) {
  // Seed coords from mock data so the map renders instantly
  const seedCoords = useMemo<LiveCoords>(() => {
    const out: LiveCoords = {};
    for (const v of vehicles) {
      const c = geotabCoordsForVehicle(v.id);
      if (c) out[v.id] = { lat: c.lat, lng: c.lng, capturedAt: new Date().toISOString() };
    }
    return out;
  }, [vehicles]);

  const [liveCoords, setLiveCoords] = useState<LiveCoords>(seedCoords);
  const [lastUpdate, setLastUpdate] = useState<string>(new Date().toISOString());
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  // Tracks whether the component is still mounted. The async refresh below can
  // resolve after the user has navigated away; committing its setState then
  // makes react-leaflet update markers against a map that MapContainer has
  // already torn down, which throws "reading '_leaflet_pos'" during the commit
  // and trips the app error boundary. Skipping the setState after unmount
  // closes that race at the source.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function refresh() {
    if (refreshingRef.current || !mountedRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const entries = await Promise.all(
        vehicles.map(async (v) => {
          const loc = await api.fetchGeotabLocation(v.id);
          return [v.id, { lat: loc.lat, lng: loc.lng, capturedAt: loc.capturedAt }] as const;
        }),
      );
      if (!mountedRef.current) return;
      setLiveCoords((prev) => {
        const next = { ...prev };
        for (const [id, c] of entries) next[id] = c;
        return next;
      });
      setLastUpdate(new Date().toISOString());
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }

  // Initial fetch + interval
  useEffect(() => {
    refresh();
    if (autoRefreshMs <= 0) return;
    const t = setInterval(refresh, autoRefreshMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefreshMs, vehicles.length]);

  const pinList = vehicles
    .map((v) => ({ vehicle: v, coord: liveCoords[v.id] }))
    .filter((x): x is { vehicle: Vehicle; coord: LiveCoord } => !!x.coord);

  const stats = useMemo(() => computeFleetStats(vehicles), [vehicles]);

  return (
    <div className={cn("flex flex-col", className)} data-testid="vehicle-map">
      {/* Pulsing-ring keyframes for moving-vehicle markers. Scoped to this
          component so it doesn't leak into the global stylesheet. */}
      <style>{`
        @keyframes vehicle-pulse {
          0%   { transform: scale(1);   opacity: 0.7; }
          70%  { transform: scale(1.6); opacity: 0;   }
          100% { transform: scale(1.6); opacity: 0;   }
        }
      `}</style>

      {/* Stats bar (only on the full /admin/map page) */}
      {showStatsBar && (
        <div
          className="flex items-center gap-4 px-3 py-2 border-b border-border bg-card text-xs font-mono"
          data-testid="vehicle-map-stats"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <strong className="text-foreground">{stats.moving}</strong>
            <span className="text-muted-foreground">moving</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-500" />
            <strong className="text-foreground">{stats.stopped}</strong>
            <span className="text-muted-foreground">stopped</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <strong className="text-foreground">{stats.stale}</strong>
            <span className="text-muted-foreground">stale (&gt;30 min)</span>
          </span>
        </div>
      )}

      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30",
          !showStatsBar && "rounded-t-lg",
        )}
      >
        <div className="text-xs text-muted-foreground font-mono">
          {pinList.length} vehicle{pinList.length === 1 ? "" : "s"} · last update{" "}
          <span data-testid="vehicle-map-last-update">{relativeTime(lastUpdate)}</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          data-testid="vehicle-map-refresh"
          className="inline-flex items-center gap-1.5 text-xs text-amber-brand hover:underline disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} /> Refresh now
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] flex-1 min-h-0">
        {/* Map */}
        <div
          style={{ height }}
          className={cn(
            "bg-muted",
            showSidebar ? "lg:rounded-bl-lg" : "rounded-b-lg",
            "overflow-hidden",
          )}
        >
          <MapBoundary height={height}>
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            style={{ height: "100%", width: "100%" }}
            scrollWheelZoom={interactive}
            dragging={interactive}
            doubleClickZoom={interactive}
            zoomControl={interactive}
            attributionControl
          >
            <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
            <FitToPins coords={pinList.map((p) => p.coord)} />
            <FocusOnVehicle focusVehicleId={focusVehicleId} coords={liveCoords} />
            {pinList.map(({ vehicle, coord }) => (
              <Marker
                key={vehicle.id}
                position={[coord.lat, coord.lng]}
                icon={buildIcon(vehicle)}
                eventHandlers={
                  onVehicleClick ? { click: () => onVehicleClick(vehicle.id) } : undefined
                }
              >
                <Popup>
                  <div className="text-xs space-y-1 min-w-[180px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-amber-brand">{vehicle.id}</span>
                      <StatusBadge
                        status={
                          vehicle.status === "operational"
                            ? "Operational"
                            : vehicle.status === "maintenance"
                              ? "In maintenance"
                              : "Out of service"
                        }
                      />
                    </div>
                    <div className="font-semibold">{vehicle.name}</div>
                    <div className="text-muted-foreground">
                      Driver: {driverById(vehicle.driverId)?.name ?? "Unassigned"}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold",
                          isVehicleMoving(vehicle)
                            ? "bg-emerald-500/15 text-emerald-700"
                            : "bg-gray-500/15 text-gray-700",
                        )}
                        data-testid={`vehicle-popup-state-${vehicle.id}`}
                      >
                        <span
                          className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            isVehicleMoving(vehicle) ? "bg-emerald-500" : "bg-gray-500",
                          )}
                        />
                        {isVehicleMoving(vehicle) ? "Moving" : "Stopped"}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {typeof vehicle.speedMph === "number"
                          ? `${Math.round(vehicle.speedMph)} mph`
                          : "— mph"}
                      </span>
                    </div>
                    <div className="text-muted-foreground font-mono">
                      Last seen:{" "}
                      {relativeTime(
                        vehicle.lastSeenAt ?? vehicle.locationUpdatedAt ?? coord.capturedAt,
                      )}
                    </div>
                    <Link
                      to="/admin/vehicles/$id"
                      params={{ id: vehicle.id }}
                      className="inline-flex items-center gap-1 mt-1 text-amber-brand hover:underline"
                    >
                      Open detail →
                    </Link>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
          </MapBoundary>
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <aside
            className="border-t lg:border-t-0 lg:border-l border-border bg-card overflow-y-auto"
            style={{ maxHeight: height }}
            data-testid="vehicle-map-sidebar"
          >
            <ul>
              {pinList.map(({ vehicle, coord }) => {
                const driver = driverById(vehicle.driverId);
                const isFocused = focusVehicleId === vehicle.id;
                return (
                  <li key={vehicle.id}>
                    <button
                      type="button"
                      onClick={() => onVehicleClick?.(vehicle.id)}
                      data-testid={`vehicle-map-sidebar-${vehicle.id}`}
                      className={cn(
                        "w-full text-left px-3 py-3 border-b border-border/60 hover:bg-muted/40 transition-colors",
                        isFocused && "bg-amber-brand/5 border-l-4 border-l-amber-brand",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: STATUS_COLOR[vehicle.status] }}
                        />
                        <span className="font-mono text-xs font-bold text-amber-brand">
                          {vehicle.id}
                        </span>
                        <span className="text-xs text-muted-foreground truncate">
                          · {vehicle.name}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <Truck className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{driver?.name ?? "Unassigned"}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                        <Locate className="w-2.5 h-2.5" />
                        {relativeTime(coord.capturedAt)}
                      </div>
                    </button>
                  </li>
                );
              })}
              {pinList.length === 0 && (
                <li className="p-4 text-xs text-muted-foreground italic text-center">
                  No vehicles to display
                </li>
              )}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}
