import { json } from "@/lib/api-utils";
import { listPharmacies } from "@/lib/engine";

export async function GET() {
  return json({ pharmacies: listPharmacies() });
}
