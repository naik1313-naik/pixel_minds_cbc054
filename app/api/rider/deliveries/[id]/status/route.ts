import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { transitionSchema } from "@/lib/validation";
import { transitionDelivery, getDelivery } from "@/lib/delivery";

export const POST = guard(["delivery_partner", "pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = await req.json().catch(() => null);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const d = await getDelivery(id);
  if (!d) return error(404, "Delivery not found");
  if (ctx.user.role === "delivery_partner" && d.partner_id !== ctx.user.id) {
    return error(403, "Not your delivery");
  }
  if (ctx.user.role === "delivery_partner" && d.status === "AwaitingPharmacyApproval") {
    return error(409, "Waiting for pharmacy approval");
  }
  const res = await transitionDelivery(id, parsed.data.status, { userId: ctx.user.id, role: ctx.user.role });
  if (!res.ok) return error(409, res.reason ?? "Illegal transition");
  return json({ ok: true, status: parsed.data.status });
});
