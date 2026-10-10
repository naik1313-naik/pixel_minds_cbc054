import Landing from "@/components/landing/Landing";
import { getDb } from "@/lib/db";
import { listMedicines, listPharmacies } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const pharmacies = listPharmacies();
  const medicines = listMedicines();
  const db = getDb();
  const networkUnits = (db
    .prepare("SELECT COALESCE(SUM(qty_total - qty_locked),0) AS s FROM inventory")
    .get() as { s: number }).s;
  const areas = (db
    .prepare("SELECT COUNT(DISTINCT area) AS c FROM demand_events")
    .get() as { c: number }).c;

  return (
    <Landing
      stats={{
        pharmacies: pharmacies.length,
        medicines: medicines.length,
        networkUnits,
        areas: Math.max(areas, 1),
      }}
    />
  );
}
