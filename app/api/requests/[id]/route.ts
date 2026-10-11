import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { getRequestDetail } from "@/lib/engine";
import { canViewRequest } from "@/lib/access";

export const GET = guard(null, async (ctx, _req: NextRequest, params) => {
  const id = Number(params.id);
  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  const req = detail.request as { customer_id: number | null; preferred_pharmacy_id: number | null };
  if (!(await canViewRequest(ctx.user, { customer_id: req.customer_id, preferred_pharmacy_id: req.preferred_pharmacy_id, id })))
    return error(403, "Forbidden");
  return json(detail);
});
