import { guard, json, error } from "@/lib/api-utils";
import { nowIso, queryOne, queryRun } from "@/lib/db";
import { GatewayError, getPaymentGateway } from "@/lib/razorpay";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Payout account for the signed-in pharmacy owner.
 *
 * GET  — current linking state, re-read from the gateway so an owner who
 *        finished onboarding on the hosted page sees the change here.
 * POST — start (or restart) onboarding and return the hosted link.
 *
 * The owner's bank details are entered on the gateway's page. This database
 * only ever holds the resulting account id and its status.
 */
export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx) => {
  const pharmacyId = ctx.user.role === "admin" ? null : ctx.user.pharmacy_id;
  if (!pharmacyId) return error(400, "No pharmacy is linked to this account");
  const row = await queryOne<{ razorpay_account_id: string | null; payout_account_status: string | null }>(
    "SELECT razorpay_account_id, payout_account_status FROM pharmacies WHERE id = $1",
    [pharmacyId]
  );
  if (!row) return error(404, "Pharmacy not found");

  // Re-sync a submitted account so the UI reflects reality without a webhook.
  if (row.razorpay_account_id && row.payout_account_status === "submitted") {
    const status = await getPaymentGateway().fetchLinkedAccount(row.razorpay_account_id);
    if (status !== row.payout_account_status) {
      await queryRun(
        "UPDATE pharmacies SET payout_account_status = $1, payout_account_checked_at = $2 WHERE id = $3",
        [status, nowIso(), pharmacyId]
      );
      row.payout_account_status = status;
    }
  }
  return json({
    razorpayAccountId: row.razorpay_account_id,
    payoutAccountStatus: row.payout_account_status,
    // Capture is refused without an activated account, so say so plainly.
    ready: row.payout_account_status === "activated" && Boolean(row.razorpay_account_id),
  });
});

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx) => {
  const pharmacyId = ctx.user.pharmacy_id;
  if (!pharmacyId) return error(400, "No pharmacy is linked to this account");

  const pharmacy = await queryOne<{ name: string }>("SELECT name FROM pharmacies WHERE id = $1", [
    pharmacyId,
  ]);
  if (!pharmacy) return error(404, "Pharmacy not found");

  const existing = await queryOne<{ razorpay_account_id: string | null }>(
    "SELECT razorpay_account_id FROM pharmacies WHERE id = $1",
    [pharmacyId]
  );
  // An activated account is not recreated: the owner would lose their mapping.
  if (existing?.razorpay_account_id) {
    const status = await getPaymentGateway().fetchLinkedAccount(existing.razorpay_account_id);
    return json({ razorpayAccountId: existing.razorpay_account_id, payoutAccountStatus: status });
  }

  let created;
  try {
    created = await getPaymentGateway().createLinkedAccount({
      email: ctx.user.email,
      phone: ctx.user.phone,
    });
  } catch (e) {
    const message = e instanceof GatewayError ? e.message : "Payout onboarding is unavailable";
    return error(e instanceof GatewayError ? e.status : 502, message);
  }

  await queryRun(
    "UPDATE pharmacies SET razorpay_account_id = $1, payout_account_status = $2, payout_account_checked_at = $3 WHERE id = $4",
    [created.accountId, created.status, nowIso(), pharmacyId]
  );
  await recordAudit({
    actorUserId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "payout_account.linked",
    entityType: "pharmacy",
    entityId: pharmacyId,
    meta: { status: created.status },
  });
  return json({
    razorpayAccountId: created.accountId,
    payoutAccountStatus: created.status,
    onboardingUrl: created.onboardingUrl ?? null,
  });
});