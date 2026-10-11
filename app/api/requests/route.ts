import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { createRequestSchema } from "@/lib/validation";
import { createRequest, getRequestDetail, listRequests } from "@/lib/engine";
import { recordAudit } from "@/lib/audit";

export const GET = guard(null, async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const scope = url.searchParams.get("scope") ?? "own";
  const filter: { customerId?: number; pharmacyId?: number; status?: string } = { status };

  if (ctx.user.role === "customer") {
    filter.customerId = ctx.user.id;
  } else if (ctx.user.role === "pharmacy_owner" || ctx.user.role === "pharmacy_staff") {
    if (scope === "all") {
      /* network view */
    } else if (ctx.user.pharmacy_id) {
      filter.pharmacyId = ctx.user.pharmacy_id;
    }
  } else if (ctx.user.role !== "admin" && scope !== "own") {
    filter.customerId = ctx.user.id;
  }
  return json({ requests: await listRequests(filter) });
});

export const POST = guard(["customer"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const data = parsed.data;
  if (data.fulfilmentType === "delivery" && (data.deliveryLat == null || data.deliveryLng == null)) {
    return error(400, "Delivery address is required for delivery requests");
  }
  const idempotencyKey = req.headers.get("idempotency-key") ?? undefined;
  const { requestId, created } = await createRequest({
    medicineId: data.medicineId,
    qty: data.qty,
    customerId: ctx.user.id,
    customerName: ctx.user.name,
    fulfilmentType: data.fulfilmentType,
    deliveryAddress: data.deliveryAddress,
    deliveryLat: data.deliveryLat,
    deliveryLng: data.deliveryLng,
    idempotencyKey,
  });
  if (created) {
    await recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "request.created", entityType: "request", entityId: requestId });
  }
  return json({ requestId, detail: await getRequestDetail(requestId) }, created ? 201 : 200);
});
