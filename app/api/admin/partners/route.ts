import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { getDb } from "@/lib/db";
import { publicUser, type DbUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const GET = guard(["admin"], async () => {
  const rows = getDb()
    .prepare("SELECT * FROM users WHERE role = 'delivery_partner' ORDER BY id")
    .all() as DbUser[];
  return json({ partners: rows.map(publicUser) });
});

const schema = z.object({
  id: z.number().int().positive(),
  status: z.enum(["verified", "rejected", "pending"]),
});

export const PUT = guard(["admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const info = getDb()
    .prepare("UPDATE users SET partner_status = ? WHERE id = ? AND role = 'delivery_partner'")
    .run(parsed.data.status, parsed.data.id);
  if (info.changes !== 1) return error(404, "Partner not found");
  recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "partner.verify", entityType: "user", entityId: parsed.data.id, meta: { status: parsed.data.status } });
  return json({ ok: true });
});
