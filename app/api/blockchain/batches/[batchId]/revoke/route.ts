import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { revokeBatch, getBatchById } from "@/lib/blockchain/ledger";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

/**
 * Revokes a batch. Any authorized pharmacy wallet may report a revocation — the
 * contract allows it so a pharmacy can flag a bad batch it did not register.
 */
export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req, params) => {
  const batchId = Number(params.batchId);
  const batch = await getBatchById(batchId);
  if (!batch) return error(404, "Batch not found");
  if (batch.status === "Revoked") return error(409, "Batch is already revoked");

  if (ctx.user.role !== "admin" && ctx.user.pharmacy_id !== batch.pharmacy_id) {
    // A different pharmacy may still report a revocation on-chain, but its own
    // wallet must be the signer. Keep this simple and explicit for the demo.
    return error(403, "You can only revoke batches belonging to your pharmacy");
  }

  try {
    const updated = await revokeBatch(batchId, { userId: ctx.user.id, role: ctx.user.role });
    publish(channels.pharmacy(batch.pharmacy_id), {
      type: "batch.revoked",
      batchId,
      batchRef: updated.batch_ref,
      txHash: updated.tx_hash,
    });
    return json({ batch: updated });
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Revocation failed");
  }
});
