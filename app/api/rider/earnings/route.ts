import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { riderEarnings } from "@/lib/payments";
import { DELIVERY_FEE_PAISE } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * The rider's own money.
 *
 * Reports two numbers rather than one, because they mean different things:
 * `paid` is in the rider's linked account; `owed` has been collected from the
 * customer but is still held by the platform until the delivery completes. Only
 * the first is money in their bank account, and collapsing them into a single
 * "earnings" figure would be the easiest lie this screen could tell.
 */
export const GET = guard(["delivery_partner", "admin"], async (ctx) => {
  const riderId = ctx.user.role === "admin" ? null : ctx.user.id;
  if (riderId == null) return error(400, "Provide a rider id");
  const earnings = await riderEarnings(riderId);
  return json({ ...earnings, feePerDeliveryPaise: DELIVERY_FEE_PAISE });
});