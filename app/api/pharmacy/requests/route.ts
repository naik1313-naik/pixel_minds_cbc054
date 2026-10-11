import type { NextRequest } from "next/server";
import { guard, json } from "@/lib/api-utils";
import { listRequests } from "@/lib/engine";

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const scope = url.searchParams.get("scope") ?? "mine";
  if (ctx.user.role === "admin" || scope === "all") {
    return json({ requests: await listRequests({ status }) });
  }
  return json({ requests: await listRequests({ pharmacyId: ctx.user.pharmacy_id ?? -1, status }) });
});
