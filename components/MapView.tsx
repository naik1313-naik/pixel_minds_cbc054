"use client";

import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapPoint {
  lat: number;
  lng: number;
}

export interface PharmacyPin {
  id: number;
  name: string;
  lat: number;
  lng: number;
  free: number;
  distance_km: number;
  selected?: boolean;
}

export interface MapViewProps {
  pharmacy: MapPoint | null;
  destination: MapPoint | null;
  rider: MapPoint | null;
  track: MapPoint[];
  /** Rider heading in degrees (0 = north) to rotate the marker. */
  heading?: number | null;
  /** Optional pharmacy result pins (discovery map). */
  pharmacies?: PharmacyPin[];
  onSelectPharmacy?: (id: number) => void;
  className?: string;
}

const TILES = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

// --- Custom markers ---------------------------------------------------------

function makeIcon(kind: "pharmacy" | "rider" | "destination", opts: { selected?: boolean; heading?: number | null; pulse?: boolean } = {}) {
  const { selected, heading, pulse } = opts;
  let transform = "translate(-50%,-50%)";
  if (kind === "rider" && typeof heading === "number" && Number.isFinite(heading)) {
    transform = `translate(-50%,-50%) rotate(${heading}deg)`;
  }
  const ring = selected
    ? "box-shadow:0 0 0 4px rgba(13,148,136,.30),0 2px 8px rgba(0,0,0,.25);"
    : "box-shadow:0 2px 6px rgba(0,0,0,.22);";
  const pulseCss = pulse
    ? `<span style="position:absolute;inset:0;border-radius:9999px;background:#f59e0b;opacity:.5;animation:mmPulse 1.8s ease-out infinite;"></span>`
    : "";

  let inner = "";
  if (kind === "pharmacy") {
    inner = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/><path d="M9 10h.01M15 10h.01"/></svg>`;
  } else if (kind === "rider") {
    inner = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M8.7 17h3.1l2.6-6.2h2.6"/><path d="M14.4 10.8 12.3 7.6H9.6"/><path d="M18.5 17h-3.9"/></svg>`;
  } else {
    inner = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
  }

  const color =
    kind === "pharmacy" ? (selected ? "#0f766e" : "#0369a1") : kind === "rider" ? "#b45309" : "#7c3aed";
  const size = kind === "rider" ? 30 : selected ? 34 : 30;

  return L.divIcon({
    className: "mm-marker",
    html: `<div style="position:relative;width:${size}px;height:${size}px;transform:${transform};will-change:transform;">${pulseCss}<div style="position:relative;width:100%;height:100%;border-radius:9999px;background:${color};border:2px solid #fff;${ring}display:grid;place-items:center;">${inner}</div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// --- Viewport behaviour -----------------------------------------------------

function FitBounds({ points, enabled }: { points: MapPoint[]; enabled: boolean }) {
  const map = useMap();
  const key = useMemo(
    () => points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";"),
    [points]
  );
  useEffect(() => {
    if (!enabled || points.length === 0) return;
    // Only fit when the set of points actually changes, so SSE updates that
    // merely move the rider never yank the user's pan/zoom.
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15, animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, map]);
  return null;
}

function FlyToSelection({ target }: { target: MapPoint | null }) {
  const map = useMap();
  const lat = target?.lat ?? null;
  const lng = target?.lng ?? null;
  useEffect(() => {
    if (lat == null || lng == null) return;
    // Selecting a pharmacy card should bring it into view, but never re-fly
    // while the user is panning (only fires when the selection actually changes).
    map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.7 });
  }, [lat, lng, map]);
  return null;
}

function ZoomControl() {
  const map = useMap();
  return (
    <div className="absolute right-3 top-3 z-[400] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-md">
      <button
        type="button"
        aria-label="Zoom in"
        className="grid h-8 w-8 place-items-center text-lg leading-none text-slate-600 hover:bg-slate-50"
        onClick={() => map.zoomIn()}
      >
        +
      </button>
      <div className="h-px bg-slate-200" />
      <button
        type="button"
        aria-label="Zoom out"
        className="grid h-8 w-8 place-items-center text-lg leading-none text-slate-600 hover:bg-slate-50"
        onClick={() => map.zoomOut()}
      >
        −
      </button>
    </div>
  );
}

function RecenterButton({ target }: { target: MapPoint | null }) {
  const map = useMap();
  if (!target) return null;
  return (
    <button
      type="button"
      aria-label="Recentre map"
      onClick={() => map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 15), { duration: 0.6 })}
      className="absolute right-3 top-[86px] z-[400] grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-md hover:bg-slate-50"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
    </button>
  );
}

// --- Legend -----------------------------------------------------------------

function Legend({ showPharmacyPins }: { showPharmacyPins: boolean }) {
  const items = [
    ...(showPharmacyPins ? [{ color: "#0369a1", label: "Pharmacy" }] : []),
    { color: "#b45309", label: "Rider (simulated GPS)" },
    { color: "#7c3aed", label: "Delivery address" },
  ];
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-[400] flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-2 text-[11px] font-medium text-slate-600 shadow-sm">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// --- Main -------------------------------------------------------------------

export default function MapView({
  pharmacy,
  destination,
  rider,
  track,
  heading,
  pharmacies = [],
  onSelectPharmacy,
  className = "h-[320px] w-full",
}: MapViewProps) {
  const center = rider ?? destination ?? pharmacy ?? pharmacies[0] ?? { lat: 12.9719, lng: 77.6412 };

  const boundsPoints = useMemo(
    () => [pharmacy, destination, ...pharmacies].filter(Boolean) as MapPoint[],
    [pharmacy, destination, pharmacies]
  );
  const selectedPin = useMemo(
    () => pharmacies.find((p) => p.selected) ?? null,
    [pharmacies]
  );
  const trackPositions = useMemo(() => track.map((p) => [p.lat, p.lng] as [number, number]), [track]);
  const routePositions = useMemo(() => {
    const start = pharmacy ? ([pharmacy.lat, pharmacy.lng] as [number, number]) : null;
    if (!trackPositions.length) return start ? [start] : [];
    return start ? [start, ...trackPositions] : trackPositions;
  }, [pharmacy, trackPositions]);

  const pharmacyIcon = useMemo(() => makeIcon("pharmacy", { selected: false }), []);
  const pharmacySelectedIcon = useMemo(() => makeIcon("pharmacy", { selected: true }), []);
  const riderIcon = useMemo(() => makeIcon("rider", { heading, pulse: true }), [heading]);
  const destIcon = useMemo(() => makeIcon("destination"), []);

  return (
    <div className={`relative overflow-hidden rounded-xl ${className}`}>
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={13}
        scrollWheelZoom={false}
        zoomControl={false}
        className="h-full w-full"
      >
        <TileLayer url={TILES.url} attribution={TILES.attribution} />
        <FitBounds points={boundsPoints} enabled={boundsPoints.length > 1} />
        <FlyToSelection target={selectedPin} />
        <ZoomControl />
        <RecenterButton target={rider ?? destination ?? pharmacy ?? null} />

        {/* Full route (pharmacy → destination) */}
        {routePositions.length > 1 && (
          <Polyline positions={routePositions} pathOptions={{ color: "#0d9488", weight: 3, opacity: 0.5 }} />
        )}
        {/* Travelled portion */}
        {trackPositions.length > 1 && (
          <Polyline positions={trackPositions} pathOptions={{ color: "#0d9488", weight: 4, opacity: 0.95 }} />
        )}

        {pharmacies.map((p) => (
          <Marker
            key={p.id}
            position={[p.lat, p.lng]}
            icon={p.selected ? pharmacySelectedIcon : pharmacyIcon}
            eventHandlers={onSelectPharmacy ? { click: () => onSelectPharmacy(p.id) } : undefined}
            zIndexOffset={p.selected ? 1000 : 0}
          >
            <Popup>
              <strong>{p.name}</strong>
              <br />
              {p.free} in stock · {p.distance_km.toFixed(1)} km
            </Popup>
          </Marker>
        ))}

        {pharmacy && (
          <Marker position={[pharmacy.lat, pharmacy.lng]} icon={pharmacySelectedIcon} zIndexOffset={900}>
            <Popup><strong>Pickup pharmacy</strong></Popup>
          </Marker>
        )}

        {destination && (
          <Marker position={[destination.lat, destination.lng]} icon={destIcon} zIndexOffset={800}>
            <Popup><strong>Delivery address</strong></Popup>
          </Marker>
        )}

        {rider && (
          <Marker position={[rider.lat, rider.lng]} icon={riderIcon} zIndexOffset={1100}>
            <Popup><strong>Delivery partner</strong><br />Simulated GPS position</Popup>
          </Marker>
        )}
      </MapContainer>
      <Legend showPharmacyPins={pharmacies.length > 0} />
    </div>
  );
}