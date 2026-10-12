import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { verifyBatchRef } from "@/lib/blockchain/ledger";
import { getBatchByRef } from "@/lib/blockchain/ledger";

export const runtime = "nodejs";

/**
 * Public batch verification.
 *
 * Reads actual contract state. An unreachable RPC is reported as UNAVAILABLE,
 * never as proof that a batch is fake.
 */
export const GET = guard(
  null,
  async (ctx, req: NextRequest, params: Record<string, string>) => {
    void ctx;
    const batchRef = params.batchId ?? new URL(req.url).searchParams.get("batchRef") ?? "";
    if (!batchRef || batchRef.length > 64) {
      return error(400, "A batch reference is required");
    }

    const verification = await verifyBatchRef(batchRef);
    const local = await getBatchByRef(batchRef);

    return json({
      verification,
      // Non-sensitive application context: medicine catalogue + pharmacy name.
      // Never customer details.
      application: local
        ? {
            status: local.status,
            medicineName: local.medicine_name,
            pharmacyName: local.pharmacy_name,
            quantityUnits: local.quantity_units,
            expiryDate: local.expiry_date,
            manufacturedAt: local.manufactured_at,
            registeredAt: local.registered_at,
          }
        : null,
    });
  }
);
