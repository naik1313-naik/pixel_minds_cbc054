import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error } from "@/lib/api-utils";
import { nowIso } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  CATEGORY_LABELS,
  DisputeError,
  listOpenDisputes,
  respondToDispute,
  resolveDispute,
} from "@/lib/disputes";

export const runtime = "nodejs";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("respond"),
    disputeId: z.number().int().positive(),
    response: z.string().min(2).max(1000),
  }),
  z.object({
    action: z.literal("resolve"),
    disputeId: z.number().int().positive(),
    outcome: z.enum(["refund", "reject"]),
    note: z.string().min(2).max(1000),
  }),
]);

/** The operator's dispute queue. */
export const GET = guard(["admin"], async () => {
  const disputes = await listOpenDisputes();
  return json({
    disputes: disputes.map((d) => ({ ...d, categoryLabel: CATEGORY_LABELS[d.category] ?? d.category })),
  });
});

export const POST = guard(["admin", "pharmacy_owner", "pharmacy_staff"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const data = parsed.data;

  try {
    if (data.action === "respond") {
      const dispute = await respondToDispute({
        disputeId: data.disputeId,
        actor: { userId: ctx.user.id, role: ctx.user.role, pharmacyId: ctx.user.pharmacy_id },
        response: data.response,
      });
      return json({ ok: true, dispute });
    }

    // Only an operator decides outcomes; a pharmacy may answer, not rule.
    if (ctx.user.role !== "admin") return error(403, "Only an admin can resolve a dispute");
    const result = await resolveDispute({
      disputeId: data.disputeId,
      actor: { userId: ctx.user.id, role: ctx.user.role },
      outcome: data.outcome,
      note: data.note,
    });
    await recordAudit({
      actorUserId: ctx.user.id,
      actorRole: ctx.user.role,
      action: `dispute.${data.outcome}`,
      entityType: "dispute",
      entityId: data.disputeId,
      meta: { offline: result.offline, refundedPaise: result.refundedPaise },
    });
    return json({ ok: true, ...result, at: nowIso() });
  } catch (e) {
    if (e instanceof DisputeError) return error(e.status, e.message);
    throw e;
  }
});