import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { getLockSeconds, setLockSeconds } from "@/lib/engine";
import { recordAudit } from "@/lib/audit";

export const GET = guard(["admin", "pharmacy_owner", "pharmacy_staff"], async () => {
  return json({ lockSeconds: getLockSeconds() });
});

const schema = z.object({ lockSeconds: z.number().int().min(5).max(7200) });

export const PUT = guard(["admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  setLockSeconds(parsed.data.lockSeconds);
  recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "settings.lock_seconds", meta: { lockSeconds: parsed.data.lockSeconds } });
  return json({ ok: true, lockSeconds: getLockSeconds() });
});
