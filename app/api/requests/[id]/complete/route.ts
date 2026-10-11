import { guard, json, error } from "@/lib/api-utils";
import { completeRequest, getRequestDetail } from "@/lib/engine";

export const POST = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const res = await completeRequest(id, { userId: ctx.user.id, role: ctx.user.role });
  if (!res.ok) return error(400, res.reason ?? "Cannot complete");
  return json({ ok: true, detail: await getRequestDetail(id) });
});
