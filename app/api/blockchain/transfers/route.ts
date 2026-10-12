import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { transferInitiateSchema } from "@/lib/validation";
import { getBatchById } from "@/lib/blockchain/ledger";
import { listTransfers, initiateTransfer } from "@/lib/blockchain/ledger";
import { listPharmacies } from "@/lib/engine";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = transferInitiateSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const { batchId, fromPharmacyId, toPharmacyId, quantity } = parsed.data;

  // Only the source pharmacy (or an admin) may initiate its transfer.
  if (ctx.user.role !== "admin" && ctx.user.pharmacy_id !== fromPharmacyId) {
    return error(403, "You can only initiate transfers from your own pharmacy");
  }

  const batch = await getBatchById(batchId);
  if (!batch) return error(404, "Batch not found");
  if (batch.pharmacy_id !== fromPharmacyId) {
    return error(403, "This batch does not belong to your pharmacy");
  }
  if (batch.status !== "Registered") {
    return error(409, `Batch is ${batch.status}; only registered batches can be transferred`);
  }

  try {
    const transfer = await initiateTransfer({
      batchId,
      fromPharmacyId,
      toPharmacyId,
      quantity,
      actor: { userId: ctx.user.id, role: ctx.user.role },
      idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
    });

    // Only after a confirmed on-chain initiation and an applied stock move.
    publish(channels.pharmacy(fromPharmacyId), {
      type: "transfer.initiated",
      transferId: transfer.id,
      status: transfer.status,
      txHash: transfer.tx_hash,
    });
    publish(channels.pharmacy(toPharmacyId), {
      type: "transfer.initiated",
      transferId: transfer.id,
      status: transfer.status,
      txHash: transfer.tx_hash,
    });

    return json({ transfer }, 201);
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Transfer initiation failed");
  }
});

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const batchIdParam = url.searchParams.get("batchId");
  const requested = url.searchParams.get("pharmacyId");

  if (ctx.user.role === "admin") {
    const pharmacyId = requested ? Number(requested) : undefined;
    return json({
      transfers: await listTransfers({ pharmacyId, batchId: batchIdParam ? Number(batchIdParam) : undefined }),
      pharmacies: await listPharmacies(),
    });
  }

  const pharmacyId = ctx.user.pharmacy_id;
  if (!pharmacyId) return error(400, "No pharmacy context");

  const transfers = await listTransfers({
    pharmacyId,
    batchId: batchIdParam ? Number(batchIdParam) : undefined,
  });
  return json({
    transfers,
    // Destinations this pharmacy may send to (verified pharmacies, not itself).
    pharmacies: (await listPharmacies()).filter(
      (p) => p.verification_status === "verified" && p.id !== pharmacyId
    ),
  });
});
