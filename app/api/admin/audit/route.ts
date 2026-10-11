import type { NextRequest } from "next/server";
import { guard, json } from "@/lib/api-utils";
import { listAudit } from "@/lib/audit";

export const GET = guard(["admin"], async (_ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const actorUserId = url.searchParams.get("actorUserId");
  return json({ audit: await listAudit({ limit, actorUserId: actorUserId ? Number(actorUserId) : undefined }) });
});
