import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { queryOne, queryRun } from "@/lib/db";
import { recordAudit } from "@/lib/audit";

const schema = z.object({ online: z.boolean() });

export const POST = guard(["delivery_partner", "admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const status = await queryOne<{ partner_status: string | null }>(
    "SELECT partner_status FROM users WHERE id = $1",
    [ctx.user.id]
  );
  if (ctx.user.role === "delivery_partner" && status?.partner_status !== "verified") {
    return error(403, "Your partner account is pending verification");
  }
  await queryRun("UPDATE users SET partner_online = $1 WHERE id = $2", [
    parsed.data.online ? 1 : 0,
    ctx.user.id,
  ]);
  await recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: parsed.data.online ? "partner.online" : "partner.offline", entityType: "user", entityId: ctx.user.id });
  return json({ ok: true, online: parsed.data.online });
});
