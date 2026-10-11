import Landing from "@/components/landing/Landing";
import { queryOne } from "@/lib/db";
import { listMedicines, listPharmacies } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const pharmacies = await listPharmacies();
  const medicines = await listMedicines();
  const network = await queryOne<{ s: number }>(
    "SELECT COALESCE(SUM(qty_total - qty_locked),0)::int AS s FROM inventory"
  );
  const areaRow = await queryOne<{ c: number }>(
    "SELECT COUNT(DISTINCT area)::int AS c FROM demand_events"
  );
  const networkUnits = network?.s ?? 0;
  const areas = areaRow?.c ?? 0;

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
