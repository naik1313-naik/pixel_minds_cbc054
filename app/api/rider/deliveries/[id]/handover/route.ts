import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { handoverSchema } from "@/lib/validation";
import { verifyHandover } from "@/lib/delivery";

export const POST = guard(["delivery_partner"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = await req.json().catch(() => null);
  const parsed = handoverSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const res = await verifyHandover({
    deliveryId: id,
    userId: ctx.user.id,
    otp: parsed.data.otp.trim(),
    idChecked: parsed.data.idChecked,
  });
  if (!res.ok) return error(400, res.reason ?? "Handover failed");
  return json({ ok: true, status: "Delivered" });
});
