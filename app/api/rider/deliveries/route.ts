import { guard, json } from "@/lib/api-utils";
import { listDeliveriesForPartner, sweepDeliveries, pendingOffersForPartner } from "@/lib/delivery";

export const GET = guard(["delivery_partner"], async (ctx) => {
  sweepDeliveries();
  return json({
    deliveries: listDeliveriesForPartner(ctx.user.id),
    offers: pendingOffersForPartner(ctx.user.id),
  });
});
