import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { reconcilePending, listUnsettledOperations } from "@/lib/blockchain/transactions";
import { getChainStatus } from "@/lib/blockchain/client";
import { reconcileSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * Reconciles blockchain operations left in an unsettled state.
 *
 * Restricted to admin: it inspects every entity's outbox rows. The mechanism
 * only *reads* receipts — it never re-submits a transaction, which is what
 * keeps a retry from double-applying stock or a double registration.
 */
export const POST = guard(["admin"], async (ctx, req: NextRequest) => {
  void ctx;
  const body = await req.json().catch(() => ({}));
  const parsed = reconcileSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const status = await getChainStatus();
  if (!status.rpcReachable) {
    return json(
      {
        reconciled: { checked: 0, confirmed: 0, failed: 0, stillPending: 0 },
        chain: status,
        operations: [],
        note: status.error ?? "Local blockchain unreachable.",
      },
      503
    );
  }

  const reconciled = await reconcilePending();
  const operations = await listUnsettledOperations(20);
  return json({ reconciled, chain: status, operations });
});

export const GET = guard(["admin"], async () => {
  const status = await getChainStatus();
  return json({ chain: status, operations: await listUnsettledOperations(50) });
});
