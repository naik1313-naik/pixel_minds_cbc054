import { guard, json } from "@/lib/api-utils";
import { getDb } from "@/lib/db";
import { insights } from "@/lib/engine";
import { listAllDeliveries } from "@/lib/delivery";

export const GET = guard(["admin"], async () => {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE role='delivery_partner' AND partner_status='pending') AS pending_partners,
        (SELECT COUNT(*) FROM pharmacies WHERE verification_status='pending') AS pending_pharmacies,
        (SELECT COUNT(*) FROM requests) AS requests,
        (SELECT COUNT(*) FROM requests WHERE status IN ('Requested','Sourcing','NeedsVerification','PartialOffer','Confirmed','Ready')) AS active_requests,
        (SELECT COUNT(*) FROM deliveries WHERE status NOT IN ('Delivered','Cancelled','ReturnedToPharmacy')) AS active_deliveries,
        (SELECT COUNT(*) FROM sessions WHERE revoked=0) AS active_sessions`
    )
    .get();
  const ins = insights();
  return json({
    counts,
    insights: ins,
    deliveries: listAllDeliveries(),
  });
});
