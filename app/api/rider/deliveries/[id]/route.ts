import { guard, json, error } from "@/lib/api-utils";
import { deliveryView, getTrack, getDelivery } from "@/lib/delivery";
import { canViewDelivery } from "@/lib/access";

export const GET = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const d = getDelivery(id);
  if (!d) return error(404, "Delivery not found");
  if (!canViewDelivery(ctx.user, { partner_id: d.partner_id, pharmacy_id: d.pharmacy_id, request_id: d.request_id }))
    return error(403, "Forbidden");
  const view = deliveryView(id);
  return json({ ...view, track: getTrack(id, 300) });
});
