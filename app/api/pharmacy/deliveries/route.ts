import { guard, json } from "@/lib/api-utils";
import { listActiveDeliveriesForPharmacy, sweepDeliveries } from "@/lib/delivery";

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx) => {
  await sweepDeliveries();
  return json({ deliveries: await listActiveDeliveriesForPharmacy(ctx.user.pharmacy_id ?? -1) });
});
