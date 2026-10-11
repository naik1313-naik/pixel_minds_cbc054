import { guard, json, error } from "@/lib/api-utils";
import { getRequestDetail } from "@/lib/engine";
import { getDeliveryForRequest, getDemoOtp, isDemoMode } from "@/lib/delivery";
import { canViewRequest } from "@/lib/access";

// DEMO ONLY: reveals the handover OTP to the owning customer's screen.
export const GET = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  const req = detail.request as { customer_id: number | null; preferred_pharmacy_id: number | null };
  if (!(await canViewRequest(ctx.user, { customer_id: req.customer_id, preferred_pharmacy_id: req.preferred_pharmacy_id, id })))
    return error(403, "Forbidden");
  if (!(await isDemoMode())) return error(404, "Not available");
  const delivery = await getDeliveryForRequest(id);
  if (!delivery) return error(404, "No delivery for this request");
  const otp = await getDemoOtp(delivery.id, ctx.user.role === "customer" ? ctx.user.id : null);
  if (!otp) return json({ otp: null });
  return json({ otp, deliveryId: delivery.id });
});
