import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { transferSettleSchema } from "@/lib/validation";
import {
  confirmTransfer,
  rejectTransfer,
  getTransferById,
} from "@/lib/blockchain/ledger";
import { queryOne } from "@/lib/db";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

/**
 * Destination-only confirmation.
 *
 * The contract enforces this on-chain; this check exists so the API returns a
 * clean 403 instead of a chain revert, and so a wrong pharmacy learns nothing
 * about the transfer beyond "not yours".
 */
export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req, params) => {
  const transfer = await getTransferById(Number(params.id));
  if (!transfer) return error(404, "Transfer not found");

  if (ctx.user.role !== "admin") {
    if (ctx.user.pharmacy_id !== transfer.to_pharmacy_id) {
      return error(403, "Only the destination pharmacy can confirm this transfer");
    }
  }

  const body = await req.json().catch(() => ({}));
  const parsed = transferSettleSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");

  // Reconcile the current status before settling so a double submit is refused.
  if (transfer.status !== "Initiated") {
    return error(409, `Transfer is already ${transfer.status}`);
  }
  if (!transfer.stock_applied) {
    return error(409, "Stock for this transfer has not been applied yet");
  }

  try {
    const updated = await confirmTransfer(transfer.id, { userId: ctx.user.id, role: ctx.user.role });
    publish(channels.pharmacy(transfer.from_pharmacy_id), {
      type: "transfer.confirmed",
      transferId: transfer.id,
      status: updated.status,
      txHash: updated.confirm_tx_hash,
    });
    publish(channels.pharmacy(transfer.to_pharmacy_id), {
      type: "transfer.confirmed",
      transferId: transfer.id,
      status: updated.status,
      txHash: updated.confirm_tx_hash,
    });
    return json({ transfer: updated });
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Transfer confirmation failed");
  }
});

/** Destination rejects a transfer. No stock ever moved, so nothing is reversed. */
export const DELETE = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req, params) => {
  const transfer = await getTransferById(Number(params.id));
  if (!transfer) return error(404, "Transfer not found");
  if (ctx.user.role !== "admin" && ctx.user.pharmacy_id !== transfer.to_pharmacy_id) {
    return error(403, "Only the destination pharmacy can reject this transfer");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = transferSettleSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");

  // Confirm the batch is still active on-chain before allowing a rejection.
  const batch = await queryOne<{ batch_ref: string; status: string }>(
    "SELECT batch_ref, status FROM medicine_batches WHERE id = $1",
    [transfer.batch_id]
  );
  if (!batch) return error(404, "Batch not found");

  try {
    const updated = await rejectTransfer(
      transfer.id,
      parsed.data.reason ?? "Rejected by destination pharmacy",
      { userId: ctx.user.id, role: ctx.user.role }
    );
    publish(channels.pharmacy(transfer.from_pharmacy_id), {
      type: "transfer.initiated",
      transferId: transfer.id,
      status: updated.status,
      txHash: updated.confirm_tx_hash,
    });
    return json({ transfer: updated });
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Transfer rejection failed");
  }
});
