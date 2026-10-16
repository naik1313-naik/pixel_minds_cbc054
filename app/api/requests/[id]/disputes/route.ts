import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { canViewRequest } from "@/lib/access";
import { getRequestDetail } from "@/lib/engine";
import {
  CATEGORY_LABELS,
  DISPUTE_CATEGORIES,
  DisputeError,
  listDisputesForRequest,
  raiseDispute,
} from "@/lib/disputes";

export const runtime = "nodejs";

/** The dispute history for one order, visible to everyone entitled to the order. */
export const GET = guard(null, async (ctx, _req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, { ...detail.request, id }))) return error(403, "Forbidden");

  const disputes = await listDisputesForRequest(id);
  return json({
    disputes: disputes.map((d) => ({
      ...d,
      categoryLabel: CATEGORY_LABELS[d.category] ?? d.category,
    })),
    categories: DISPUTE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
    // Only the ordering customer may raise one.
    canRaise:
      ctx.user.role === "customer" &&
      detail.request.customer_id === ctx.user.id &&
      !disputes.some((d) => d.status === "Open" || d.status === "Responded"),
  });
});

export const POST = guard(["customer"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = (await req.json().catch(() => null)) as {
    category?: string;
    reason?: string;
  } | null;

  const category = body?.category;
  const reason = (body?.reason ?? "").trim();
  if (!category || !DISPUTE_CATEGORIES.includes(category as never)) {
    return error(400, "Choose what went wrong");
  }
  if (reason.length < 5) return error(400, "Tell us a little more");

  try {
    const dispute = await raiseDispute({
      requestId: id,
      actor: { userId: ctx.user.id, role: ctx.user.role },
      category: category as never,
      reason,
    });
    return json({ ok: true, dispute }, 201);
  } catch (e) {
    if (e instanceof DisputeError) return error(e.status, e.message);
    throw e;
  }
});