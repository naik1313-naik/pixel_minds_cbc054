import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { queryRun } from "@/lib/db";
import { listPharmacies } from "@/lib/engine";
import { recordAudit } from "@/lib/audit";

export const GET = guard(["admin", "pharmacy_owner", "pharmacy_staff"], async () => {
  return json({ pharmacies: await listPharmacies() });
});

const schema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["verified", "rejected", "pending"]),
});

export const PUT = guard(["admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const changes = await queryRun(
    "UPDATE pharmacies SET verification_status = $1 WHERE id = $2",
    [parsed.data.status, parsed.data.id]
  );
  if (changes !== 1) return error(404, "Pharmacy not found");
  await recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "pharmacy.verify", entityType: "pharmacy", entityId: parsed.data.id, meta: { status: parsed.data.status } });
  return json({ ok: true });
});
