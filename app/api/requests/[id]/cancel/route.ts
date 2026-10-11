import { guard, json, error } from "@/lib/api-utils";
import { cancelRequest, getRequestDetail } from "@/lib/engine";

export const POST = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const res = await cancelRequest(id, { userId: ctx.user.id, role: ctx.user.role });
  if (!res.ok) return error(400, res.reason ?? "Cannot cancel");
  return json({ ok: true, detail: await getRequestDetail(id) });
});
