import { guard, json } from "@/lib/api-utils";
import { listDeliveriesForPartner, sweepDeliveries, pendingOffersForPartner } from "@/lib/delivery";

export const GET = guard(["delivery_partner"], async (ctx) => {
  await sweepDeliveries();
  return json({
    deliveries: await listDeliveriesForPartner(ctx.user.id),
    offers: await pendingOffersForPartner(ctx.user.id),
  });
});
