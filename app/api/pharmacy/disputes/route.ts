import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { nowIso } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { CATEGORY_LABELS, DisputeError, listDisputesForPharmacy, respondToDispute } from "@/lib/disputes";

export const runtime = "nodejs";

/** Disputes raised against this pharmacy's orders, so it can answer them. */
export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx) => {
  const pharmacyId = ctx.user.role === "admin" ? null : ctx.user.pharmacy_id;
  if (!pharmacyId) return error(400, "No pharmacy is linked to this account");
  const disputes = await listDisputesForPharmacy(pharmacyId);
  return json({
    disputes: disputes.map((d) => ({ ...d, categoryLabel: CATEGORY_LABELS[d.category] ?? d.category })),
  });
});

export const POST = guard(["pharmacy_owner", "pharmacy_staff"], async (ctx, req: NextRequest) => {
  const body = (await req.json().catch(() => null)) as {
    disputeId?: number;
    response?: string;
  } | null;
  const disputeId = Number(body?.disputeId);
  const response = (body?.response ?? "").trim();
  if (!Number.isFinite(disputeId) || response.length < 2) return error(400, "Write a reply first");

  try {
    const dispute = await respondToDispute({
      disputeId,
      actor: { userId: ctx.user.id, role: ctx.user.role, pharmacyId: ctx.user.pharmacy_id },
      response,
    });
    await recordAudit({
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role,
      action: "dispute.responded",
      entityType: "dispute",
      entityId: disputeId,
      meta: { pharmacyId: ctx.user.pharmacy_id },
    });
    return json({ ok: true, dispute, at: nowIso() });
  } catch (e) {
    if (e instanceof DisputeError) return error(e.status, e.message);
    throw e;
  }
});