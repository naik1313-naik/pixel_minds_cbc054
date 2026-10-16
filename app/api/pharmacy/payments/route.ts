import { guard, json, error } from "@/lib/api-utils";
import { listPharmacyPayments, payoutAccountReadyFor } from "@/lib/payments";
import { rupees } from "@/lib/constants";

export const runtime = "nodejs";

/**
 * Payout ledger for the signed-in pharmacy owner: what was sold, what was
 * routed to their account, and what is still pending capture.
 *
 * Scoped strictly to the caller's own pharmacy. Admin sees everything.
 */
export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  const pharmacyId =
    ctx.user.role === "admin"
      ? Number(new URL(req.url).searchParams.get("pharmacyId") ?? 0) || null
      : ctx.user.pharmacy_id;
  if (!pharmacyId) return error(400, "No pharmacy is linked to this account");

  const { rows, totals } = await listPharmacyPayments(pharmacyId, Number.isFinite(limit) ? limit : 50);
  // Read once for the whole table: readiness is a property of the pharmacy, and
  // every row would otherwise repeat the same two-column lookup.
  const payoutReady = await payoutAccountReadyFor(pharmacyId);
  return json({
    pharmacyId,
    totals: {
      paidOutPaise: totals.paid_out_paise,
      paidOutLabel: rupees(totals.paid_out_paise),
      pendingPaise: totals.captured_paise,
      pendingLabel: rupees(totals.captured_paise),
      count: totals.count,
    },
    payments: rows.map((p) => ({
      id: p.id,
      requestId: p.request_id,
      medicine: p.medicine_name,
      status: p.status,
      amountLabel: rupees(p.amount_paise),
      pharmacyAmountLabel: rupees(p.pharmacy_amount_paise),
      platformFeeLabel: rupees(p.platform_fee_paise),
      payoutAccountReady: payoutReady,
      transferId: p.razorpay_transfer_id,
      capturedAt: p.captured_at,
      paidOutAt: p.paid_out_at,
      failureReason: p.failure_reason,
      refundedAt: p.refunded_at,
      // On-chain pointer for the public verification page.
      settlementRef: p.settlement_ref ?? null,
      blockNumber: p.block_number ?? null,
    })),
  });
});