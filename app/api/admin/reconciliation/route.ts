import { guard, json } from "@/lib/api-utils";
import { queryAll, queryOne } from "@/lib/db";
import { OPERATION_STATUS, reconcilePending } from "@/lib/blockchain/transactions";
import { getChainStatus } from "@/lib/blockchain/client";

export const runtime = "nodejs";

/**
 * Outbox health, for an operator.
 *
 * Every blockchain write is persisted before it is submitted, so a crash mid-write
 * leaves a row rather than a mystery. That guarantee is invisible unless somebody
 * can see the queue — an operator who cannot see `NeedsReconciliation` has no way
 * to know the audit trail has a hole in it.
 *
 * Read-only: this reports what needs attention, it does not silently repair.
 * Reconciling is a separate, deliberate POST.
 */
export const GET = guard(["admin"], async () => {
  const counts = (await queryOne(
    `SELECT
        (SELECT COUNT(*) FROM blockchain_operations WHERE status = 'NeedsReconciliation')::int AS needs_reconciliation,
        (SELECT COUNT(*) FROM blockchain_operations WHERE status = 'Submitted')::int AS submitted,
        (SELECT COUNT(*) FROM blockchain_operations WHERE status = 'Pending')::int AS pending,
        (SELECT COUNT(*) FROM blockchain_operations WHERE status = 'Failed')::int AS failed,
        (SELECT COUNT(*) FROM blockchain_operations WHERE status = 'Confirmed')::int AS confirmed,
        (SELECT COUNT(*) FROM payment_audit WHERE status IN ('Failed','NeedsReconciliation'))::int AS settlement_gaps`
  )) ?? {
    needs_reconciliation: 0,
    submitted: 0,
    pending: 0,
    failed: 0,
    confirmed: 0,
    settlement_gaps: 0,
  };

  const unsettled = await queryAll(
    `SELECT o.id, o.operation_ref, o.operation_type, o.entity_type, o.entity_id, o.status,
            o.tx_hash, o.block_number, o.attempts, o.last_error, o.updated_at
       FROM blockchain_operations o
      WHERE o.status IN ('Pending','Submitted','Failed','NeedsReconciliation')
      ORDER BY o.updated_at DESC
      LIMIT 100`
  );

  const recent = await queryAll(
    `SELECT o.id, o.operation_type, o.entity_type, o.entity_id, o.status, o.block_number, o.confirmed_at
       FROM blockchain_operations o
      WHERE o.status = $1
      ORDER BY o.confirmed_at DESC
      LIMIT 10`,
    [OPERATION_STATUS.CONFIRMED]
  );

  return json({
    counts,
    unsettled,
    recent,
    chain: await getChainStatus(),
    note:
      counts.needs_reconciliation > 0
        ? "Some writes have an unknown outcome. Reconciling reads the chain for what actually happened — it never re-submits."
        : "Every submitted write has a known outcome.",
  });
});

/** Runs the reconciliation pass. Safe to call repeatedly. */
export const POST = guard(["admin"], async () => {
  const result = await reconcilePending();
  return json({ ok: true, ...result });
});