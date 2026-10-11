import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { resetDemo } from "@/lib/db";
import { simulateOutbreak, setLockSeconds } from "@/lib/engine";
import { demoStep, getDelivery } from "@/lib/delivery";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("outbreak"), medicineId: z.number().int().positive(), area: z.string().max(60).optional() }),
  z.object({ action: z.literal("lock20") }),
  z.object({ action: z.literal("lock30") }),
  z.object({ action: z.literal("step"), deliveryId: z.number().int().positive() }),
]);

export const POST = guard(["admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const data = parsed.data;

  switch (data.action) {
    case "reset": {
      await resetDemo();
      await recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "demo.reset" });
      return json({ ok: true, action: "reset" });
    }
    case "outbreak": {
      await simulateOutbreak(data.medicineId, data.area);
      return json({ ok: true, action: "outbreak" });
    }
    case "lock20": {
      await setLockSeconds(20);
      return json({ ok: true, action: "lock20", lockSeconds: 20 });
    }
    case "lock30": {
      await setLockSeconds(1800);
      return json({ ok: true, action: "lock30", lockSeconds: 1800 });
    }
    case "step": {
      const d = await getDelivery(data.deliveryId);
      if (!d) return error(404, "Delivery not found");
      const res = await demoStep(data.deliveryId);
      return json(res);
    }
  }
});
