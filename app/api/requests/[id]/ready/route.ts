import { guard, json, error } from "@/lib/api-utils";
import { markReady, getRequestDetail } from "@/lib/engine";
import { recordDeliveryMilestone } from "@/lib/blockchain/ledger";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const res = await markReady(id, { userId: ctx.user.id, role: ctx.user.role });
  if (!res.ok) return error(400, res.reason ?? "Cannot mark ready");

  // Mirror the Packed milestone on-chain. This is best-effort: the pharmacy's
  // core workflow already succeeded and must not be undone if the local chain
  // is down. The outcome is reported honestly instead of silently swallowed.
  let audit: { recorded: boolean; error?: string; txHash?: string | null } = { recorded: false };
  if (res.deliveryId) {
    try {
      const row = await recordDeliveryMilestone({
        deliveryId: res.deliveryId,
        milestone: "Packed",
        actor: { userId: ctx.user.id, role: ctx.user.role },
      });
      audit = { recorded: row.status === "Recorded", txHash: row.tx_hash };
      if (row.status === "Recorded") {
        publish(channels.delivery(res.deliveryId), {
          type: "delivery.milestone.recorded",
          deliveryId: res.deliveryId,
          milestone: row.milestone,
          txHash: row.tx_hash,
        });
      }
    } catch (e) {
      audit = { recorded: false, error: e instanceof Error ? e.message : "On-chain audit failed" };
    }
  }

  return json({ ok: true, deliveryId: res.deliveryId ?? null, audit, detail: await getRequestDetail(id) });
});
