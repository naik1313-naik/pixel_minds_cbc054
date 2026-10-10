import type { NextRequest } from "next/server";
import { guard, json } from "@/lib/api-utils";
import { listLedger } from "@/lib/engine";

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const pharmacyIdParam = url.searchParams.get("pharmacyId");
  if (ctx.user.role === "admin") {
    return json({ ledger: listLedger(pharmacyIdParam ? Number(pharmacyIdParam) : undefined) });
  }
  return json({ ledger: listLedger(ctx.user.pharmacy_id ?? -1) });
});
