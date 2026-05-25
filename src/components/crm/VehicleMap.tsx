import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L, { type DivIcon } from "leaflet";
import { Locate, RefreshCw, Truck } from "lucide-react";
import { api } from "@/lib/api";
import { driverById, geotabCoordsForVehicle } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
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

function buildIcon(vehicle: Vehicle): DivIcon {
  const color = STATUS_COLOR[vehicle.status];
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);">
      <div style="
        width:34px;height:34px;border-radius:50%;
        background:${color};border:3px solid white;
        box-shadow:0 2px 6px rgba(0,0,0,0.35);
        display:flex;align-items:center;justify-content:center;
        color:white;font-weight:700;font-size:10px;font-family:'DM Mono',ui-monospace,monospace;
        white-space:nowrap;
      ">${vehicle.id.replace(/-/g, "")}</div>
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
    if (coords.length === 1) {
      map.setView([coords[0].lat, coords[0].lng], 14, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(coords.map((c) => [c.lat, c.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40], animate: true });
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
    map.flyTo([c.lat, c.lng], 15, { animate: true, duration: 0.6 });
  }, [focusVehicleId, coords, map]);
  return null;
}

export type VehicleMapProps = {
  vehicles: Vehicle[];
  height?: string;
  autoRefreshMs?: number;
  interactive?: boolean;
  showSidebar?: boolean;
  focusVehicleId?: string | null;
  onVehicleClick?: (id: string) => void;
  className?: string;
};

export function VehicleMap({
  vehicles,
  height = "600px",
  autoRefreshMs = 30_000,
  interactive = true,
  showSidebar = false,
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

  async function refresh() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const entries = await Promise.all(
        vehicles.map(async (v) => {
          const loc = await api.fetchGeotabLocation(v.id);
          return [v.id, { lat: loc.lat, lng: loc.lng, capturedAt: loc.capturedAt }] as const;
        }),
      );
      setLiveCoords((prev) => {
        const next = { ...prev };
        for (const [id, c] of entries) next[id] = c;
        return next;
      });
      setLastUpdate(new Date().toISOString());
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
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

  return (
    <div className={cn("flex flex-col", className)} data-testid="vehicle-map">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 rounded-t-lg">
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
                    <div className="text-muted-foreground font-mono">
                      Last seen: {relativeTime(coord.capturedAt)}
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
