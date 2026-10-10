import type { NextRequest } from "next/server";
import { json, error } from "@/lib/api-utils";
import {
  availability,
  findSubstitutes,
  competingInfo,
  getMedicine,
  rankPharmacies,
} from "@/lib/engine";
import { CUSTOMER_LOCATION } from "@/lib/geo";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const medicineId = Number(id);
  if (!Number.isFinite(medicineId)) return error(400, "Invalid id");
  const medicine = getMedicine(medicineId);
  if (!medicine) return error(404, "Medicine not found");

  const avail = availability(medicineId);
  const ranked = rankPharmacies(medicineId, 10);
  const distMap = new Map(ranked.map((r) => [r.pharmacy.id, r.distance_km]));
  const scoreMap = new Map(ranked.map((r) => [r.pharmacy.id, r.score]));

  const pharmacies = (avail?.pharmacies ?? []).map((p) => ({
    pharmacy_id: p.pharmacy_id,
    pharmacy_name: p.pharmacy_name,
    pharmacy_verification: p.verification_status,
    free: p.free,
    qty_total: p.qty_total,
    expiry_date: p.expiry_date,
    lat: p.lat,
    lng: p.lng,
    distance_km: Number((distMap.get(p.pharmacy_id) ?? 0).toFixed(2)),
    score: Number((scoreMap.get(p.pharmacy_id) ?? 0).toFixed(3)),
  }));

  return json({
    medicine,
    total_free: avail?.total_free ?? 0,
    pharmacies,
    substitutes: findSubstitutes(medicineId),
    competing: competingInfo(medicineId),
    origin: CUSTOMER_LOCATION,
  });
}
