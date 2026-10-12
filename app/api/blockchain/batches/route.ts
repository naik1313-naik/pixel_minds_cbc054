import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { batchRegisterSchema } from "@/lib/validation";
import { listBatches, registerBatch } from "@/lib/blockchain/ledger";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

/**
 * Batch registration is restricted to pharmacy users. Authorization is
 * enforced here for usability and again inside the contract, which is the
 * real boundary — a forged request from the browser cannot bypass it.
 */
export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = batchRegisterSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const pharmacyId =
    ctx.user.role === "admin"
      ? Number(new URL(req.url).searchParams.get("pharmacyId"))
      : ctx.user.pharmacy_id;

  if (!pharmacyId || !Number.isFinite(pharmacyId)) {
    return error(400, "No pharmacy context");
  }
  if (ctx.user.role !== "admin" && ctx.user.pharmacy_id !== pharmacyId) {
    return error(403, "You can only register batches for your own pharmacy");
  }

  const idempotencyKey =
    req.headers.get("idempotency-key") ?? undefined;

  try {
    const batch = await registerBatch({
      pharmacyId,
      medicineId: parsed.data.medicineId,
      quantityUnits: parsed.data.quantityUnits,
      expiryDate: parsed.data.expiryDate,
      manufacturedAt: parsed.data.manufacturedAt,
      supplierRef: parsed.data.supplierRef,
      actor: { userId: ctx.user.id, role: ctx.user.role },
      idempotencyKey,
    });

    // Published only after a confirmed receipt, never optimistically.
    publish(channels.pharmacy(pharmacyId), {
      type: "batch.registered",
      batchId: batch.id,
      batchRef: batch.batch_ref,
      txHash: batch.tx_hash,
    });

    return json({ batch }, 201);
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Blockchain submission failed");
  }
});

export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const pharmacyId =
    ctx.user.role === "admin"
      ? Number(url.searchParams.get("pharmacyId")) || undefined
      : ctx.user.pharmacy_id ?? undefined;

  const batches = await listBatches({
    pharmacyId,
    status: url.searchParams.get("status") ?? undefined,
  });
  return json({ batches });
});
