export const CUSTOMER_LOCATION = {
  lat: 12.9719,
  lng: 77.6412,
  label: "Indiranagar, Bengaluru",
  area: "Indiranagar",
};

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Demo routing: effective road distance ~1.3x straight line, city speed ~22 km/h.
export function roadDistanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return haversineKm(a, b) * 1.3;
}

export function etaMinutes(distanceKm: number, speedKmh = 22): number {
  return Math.max(1, Math.round((distanceKm / speedKmh) * 60 + 3));
}

export function interpolate(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  t: number
): { lat: number; lng: number } {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

export function headingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
