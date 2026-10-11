import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { queryAll, queryOne, queryRun, nowIso } from "@/lib/db";
import { inventoryUpdateSchema } from "@/lib/validation";
import { recordAudit } from "@/lib/audit";
import { publish, channels } from "@/lib/sse";

function resolvePharmacyId(user: { role: string; pharmacy_id: number | null }, req: NextRequest): number | null {
  if (user.role === "admin") {
    const q = new URL(req.url).searchParams.get("pharmacyId");
    return q ? Number(q) : null;
  }
  return user.pharmacy_id;
}

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req) => {
  const pharmacyId = resolvePharmacyId(ctx.user, req);
  if (!pharmacyId) return error(400, "No pharmacy context");
  const rows = await queryAll(
    `SELECT i.pharmacy_id, i.medicine_id, i.qty_total, i.qty_locked, i.expiry_date,
            m.name AS medicine_name, m.salt, m.price_paise, m.rx_required,
            (i.qty_total - i.qty_locked)::int AS free
     FROM inventory i JOIN medicines m ON m.id = i.medicine_id
     WHERE i.pharmacy_id = $1 ORDER BY m.name`,
    [pharmacyId]
  );
  return json({ pharmacyId, inventory: rows });
});

export const PUT = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req) => {
  const pharmacyId = resolvePharmacyId(ctx.user, req);
  if (!pharmacyId) return error(400, "No pharmacy context");
  const body = await req.json().catch(() => null);
  const parsed = inventoryUpdateSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const { medicineId, qtyTotal, expiryDate } = parsed.data;
  const existing = await queryOne<{ qty_total: number; qty_locked: number }>(
    "SELECT * FROM inventory WHERE pharmacy_id = $1 AND medicine_id = $2",
    [pharmacyId, medicineId]
  );
  if (existing && qtyTotal < existing.qty_locked) {
    return error(400, `Cannot set below ${existing.qty_locked} locked units`);
  }
  await queryRun(
    `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked, expiry_date)
     VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT(pharmacy_id, medicine_id) DO UPDATE SET qty_total = excluded.qty_total, expiry_date = COALESCE(excluded.expiry_date, inventory.expiry_date)`,
    [pharmacyId, medicineId, qtyTotal, expiryDate ?? null]
  );
  await recordAudit({
    actorUserId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "inventory.updated",
    entityType: "inventory",
    entityId: `${pharmacyId}:${medicineId}`,
    meta: { qtyTotal, expiryDate, at: nowIso() },
  });
  publish(channels.pharmacy(pharmacyId), { type: "inventory", pharmacyId });
  return json({ ok: true });
});
