import { json } from "@/lib/api-utils";
import { listMedicines, totalFreeStock } from "@/lib/engine";

export async function GET() {
  const meds = await listMedicines();
  const medicines = await Promise.all(
    meds.map(async (m) => ({
      ...m,
      total_free: await totalFreeStock(m.id),
    }))
  );
  return json({ medicines });
}
