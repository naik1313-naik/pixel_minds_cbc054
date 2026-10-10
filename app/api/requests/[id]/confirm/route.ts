import { guard, json, error } from "@/lib/api-utils";
import { confirmRequest, getRequestDetail } from "@/lib/engine";

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const res = confirmRequest(id, { userId: ctx.user.id, role: ctx.user.role });
  if (!res.ok) return error(400, res.reason ?? "Cannot confirm");
  return json({ ok: true, detail: getRequestDetail(id) });
});
