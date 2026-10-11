import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { pendingOffersForPartner, acceptOffer, declineOffer } from "@/lib/delivery";

export const GET = guard(["delivery_partner"], async (ctx) => {
  return json({ offers: await pendingOffersForPartner(ctx.user.id) });
});

const schema = z.object({
  deliveryId: z.number().int().positive(),
  action: z.enum(["accept", "decline"]),
});

export const POST = guard(["delivery_partner"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  if (parsed.data.action === "accept") {
    const res = await acceptOffer(parsed.data.deliveryId, ctx.user.id);
    if (!res.ok) return error(409, res.reason ?? "Could not accept");
    return json({ ok: true, status: "AwaitingPharmacyApproval" });
  }
  await declineOffer(parsed.data.deliveryId, ctx.user.id);
  return json({ ok: true, status: "Declined" });
});
