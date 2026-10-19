import Landing from "@/components/landing/Landing";
import { queryOne } from "@/lib/db";
import { listMedicines, listPharmacies } from "@/lib/engine";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Run concurrently, not in sequence.
  //
  // The queries themselves are trivial — 123 medicines, 180 stock rows, and four
  // COUNTs — so their cost is entirely round-trip time. Against a hosted database
  // from a serverless region that is the dominant term in the page's latency, and
  // awaiting them one after another pays it four times over. In parallel the page
  // costs one round-trip instead of four.
  const [pharmacies, medicines, network, areaRow] = await Promise.all([
    listPharmacies(),
    listMedicines(),
    queryOne<{ s: number }>(
      "SELECT COALESCE(SUM(qty_total - qty_locked),0)::int AS s FROM inventory"
    ),
    queryOne<{ c: number }>("SELECT COUNT(DISTINCT area)::int AS c FROM demand_events"),
  ]);
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
