import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { getDb } from "@/lib/db";
import { recordAudit } from "@/lib/audit";

const schema = z.object({ online: z.boolean() });

export const POST = guard(["delivery_partner", "admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const status = getDb()
    .prepare("SELECT partner_status FROM users WHERE id = ?")
    .get(ctx.user.id) as { partner_status: string | null } | undefined;
  if (ctx.user.role === "delivery_partner" && status?.partner_status !== "verified") {
    return error(403, "Your partner account is pending verification");
  }
  getDb().prepare("UPDATE users SET partner_online = ? WHERE id = ?").run(parsed.data.online ? 1 : 0, ctx.user.id);
  recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: parsed.data.online ? "partner.online" : "partner.offline", entityType: "user", entityId: ctx.user.id });
  return json({ ok: true, online: parsed.data.online });
});
