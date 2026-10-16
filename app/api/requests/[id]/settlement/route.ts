import { guard, json, error } from "@/lib/api-utils";
import { canViewRequest } from "@/lib/access";
import { getRequestDetail } from "@/lib/engine";
import { getPaymentForRequest, PAYMENT_STATUS } from "@/lib/payments";
import { verifySettlementOnChain } from "@/lib/blockchain/settlements";

export const runtime = "nodejs";

/**
 * Reads the settlement receipt straight from the chain and compares it with
 * what this system recorded.
 *
 * `matches` true means the anchored metadata hash is byte-identical to the one
 * computed at settlement time, i.e. the on-chain record has not been altered.
 * It is not proof that a bank transfer occurred — the chain has no visibility
 * into the payment rail, and the API says so rather than overclaiming.
 */
export const GET = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = await getRequestDetail(id);
  if (!detail?.request) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, detail.request))) return error(403, "Forbidden");

  const payment = await getPaymentForRequest(id);
  if (!payment) return error(404, "This request has no payment");

  if (payment.status !== PAYMENT_STATUS.PAID_OUT) {
    return json({ status: payment.status, anchored: false });
  }
  try {
    const chain = await verifySettlementOnChain(payment.id);
    return json({
      status: payment.status,
      anchored: chain.exists,
      metadataMatches: chain.matches,
      amountPaise: chain.amountPaise,
      // Named for what they are: the contract stores a timestamp, while the
      // block number comes from the anchoring receipt.
      settledAtUnix: chain.settledAtUnix,
      blockNumber: chain.blockNumber,
      scope:
        "Proves an authorized wallet reported this settlement and that the record is unaltered. It does not attest that money moved.",
    });
  } catch {
    return error(502, "Blockchain is unavailable; settlement cannot be verified right now");
  }
});