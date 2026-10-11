import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { locationSchema } from "@/lib/validation";
import { recordLocation } from "@/lib/delivery";

export const POST = guard(["delivery_partner"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = await req.json().catch(() => null);
  const parsed = locationSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid coordinates");
  const res = await recordLocation({
    deliveryId: id,
    userId: ctx.user.id,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    heading: parsed.data.heading,
    speed: parsed.data.speed,
  });
  if (!res.ok) return error(400, res.reason ?? "Rejected");
  return json({ ok: true });
});
