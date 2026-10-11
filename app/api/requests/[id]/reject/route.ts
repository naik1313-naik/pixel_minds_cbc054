import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { rejectRequest, getRequestDetail } from "@/lib/engine";

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = await req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : undefined;
  const res = await rejectRequest(id, { userId: ctx.user.id, role: ctx.user.role }, reason);
  if (!res.ok) return error(400, res.reason ?? "Cannot reject");
  return json({ ok: true, detail: await getRequestDetail(id) });
});
