import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { queryAll, queryRun } from "@/lib/db";
import { publicUser, type DbUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const GET = guard(["admin"], async () => {
  const rows = await queryAll<DbUser>(
    "SELECT * FROM users WHERE role = 'delivery_partner' ORDER BY id"
  );
  return json({ partners: await Promise.all(rows.map((r) => publicUser(r))) });
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
    "UPDATE users SET partner_status = $1 WHERE id = $2 AND role = 'delivery_partner'",
    [parsed.data.status, parsed.data.id]
  );
  if (changes !== 1) return error(404, "Partner not found");
  await recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "partner.verify", entityType: "user", entityId: parsed.data.id, meta: { status: parsed.data.status } });
  return json({ ok: true });
});
