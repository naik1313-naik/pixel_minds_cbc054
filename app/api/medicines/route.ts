import { json } from "@/lib/api-utils";
import { listMedicines, totalFreeStock } from "@/lib/engine";

export async function GET() {
  const meds = listMedicines().map((m) => ({
    ...m,
    total_free: totalFreeStock(m.id),
  }));
  return json({ medicines: meds });
}
