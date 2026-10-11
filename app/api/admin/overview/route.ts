import { guard, json } from "@/lib/api-utils";
import { queryOne } from "@/lib/db";
import { insights } from "@/lib/engine";
import { listAllDeliveries } from "@/lib/delivery";

export const GET = guard(["admin"], async () => {
  const counts = await queryOne(
    `SELECT
        (SELECT COUNT(*) FROM users)::int AS users,
        (SELECT COUNT(*) FROM users WHERE role='delivery_partner' AND partner_status='pending')::int AS pending_partners,
        (SELECT COUNT(*) FROM pharmacies WHERE verification_status='pending')::int AS pending_pharmacies,
        (SELECT COUNT(*) FROM requests)::int AS requests,
        (SELECT COUNT(*) FROM requests WHERE status IN ('Requested','Sourcing','NeedsVerification','PartialOffer','Confirmed','Ready'))::int AS active_requests,
        (SELECT COUNT(*) FROM deliveries WHERE status NOT IN ('Delivered','Cancelled','ReturnedToPharmacy'))::int AS active_deliveries,
        (SELECT COUNT(*) FROM sessions WHERE revoked=0)::int AS active_sessions`
  );
  const ins = await insights();
  return json({
    counts,
    insights: ins,
    deliveries: await listAllDeliveries(),
  });
});
