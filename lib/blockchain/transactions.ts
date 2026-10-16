/**
 * Durable operation tracking for blockchain writes.
 *
 * SQLite/Postgres and the EVM do not share a transaction, so every on-chain
 * write follows an outbox pattern:
 *
 *   1. persist an operation row (status Pending)   <- before any submission
 *   2. mark Submitted and store the tx hash       <- as soon as it is known
 *   3. wait for a receipt, then mark Confirmed
 *
 * If the process dies between 2 and 3 the operation stays Submitted and
 * reconcilePending() resolves it by reading the chain. That is what prevents a
 * retry from double-applying a stock adjustment or a double register.
 */
import { randomUUID } from "crypto";
import { queryAll, queryOne, queryRun, queryReturning, nowIso } from "@/lib/db";

export const OPERATION_STATUS = {
  PENDING: "Pending",
  SUBMITTED: "Submitted",
  CONFIRMED: "Confirmed",
  FAILED: "Failed",
  NEEDS_RECONCILIATION: "NeedsReconciliation",
} as const;
export type OperationStatus = (typeof OPERATION_STATUS)[keyof typeof OPERATION_STATUS];

export const OPERATION_TYPE = {
  BATCH_REGISTER: "batch.register",
  BATCH_REVOKE: "batch.revoke",
  TRANSFER_INITIATE: "transfer.initiate",
  TRANSFER_CONFIRM: "transfer.confirm",
  TRANSFER_REJECT: "transfer.reject",
  DELIVERY_MILESTONE: "delivery.milestone",
  PAYMENT_SETTLE: "payment.settle",
} as const;
export type OperationType = (typeof OPERATION_TYPE)[keyof typeof OPERATION_TYPE];

/** Failure classes that must never be blindly retried. */
export const PERMANENT_ERROR_PREFIXES = [
  "NotAdmin",
  "NotPharmacy",
  "NotDeliveryActor",
  "BatchAlreadyExists",
  "BatchNotFound",
  "BatchNotActive",
  "BatchAlreadyRevoked",
  "EmptyBatchId",
  "EmptyMetadataHash",
  "ZeroQuantity",
  "SamePharmacy",
  "TransferAlreadyExists",
  "TransferNotFound",
  "TransferNotSettled",
  "TransferAlreadySettled",
  "NotSourcePharmacy",
  "NotDestinationPharmacy",
  "MilestoneOutOfOrder",
  "MilestoneAlreadyRecorded",
  "DeliveryAlreadyDelivered",
  "InvalidMilestone",
  "ZeroAddress",
  "EmptySettlementId",
  "EmptyOrderRef",
  "EmptySettlementHash",
  "ZeroAmount",
  "SettlementAlreadyRecorded",
];

export interface OperationRow {
  id: number;
  operation_ref: string;
  operation_type: string;
  entity_type: string;
  entity_id: number;
  idempotency_key: string | null;
  status: OperationStatus;
  tx_hash: string | null;
  block_number: number | null;
  attempts: number;
  last_error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export function isPermanentFailure(message: string): boolean {
  return PERMANENT_ERROR_PREFIXES.some((p) => message.includes(p));
}

export async function createOperation(input: {
  type: OperationType;
  entityType: "batch" | "transfer" | "delivery" | "payment";
  entityId: number;
  idempotencyKey?: string;
}): Promise<OperationRow> {
  // A repeated idempotency key returns the original operation instead of
  // creating a second logical write.
  if (input.idempotencyKey) {
    const existing = await queryOne<OperationRow>(
      "SELECT * FROM blockchain_operations WHERE idempotency_key = $1",
      [input.idempotencyKey]
    );
    if (existing) return existing;
  }
  const now = nowIso();
  const ref = `op_${randomUUID()}`;
  const row = await queryReturning<OperationRow>(
    `INSERT INTO blockchain_operations
       (operation_ref, operation_type, entity_type, entity_id, idempotency_key, status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)
     RETURNING *`,
    [
      ref,
      input.type,
      input.entityType,
      input.entityId,
      input.idempotencyKey ?? null,
      OPERATION_STATUS.PENDING,
      now,
    ]
  );
  return row!;
}

export async function markSubmitted(id: number, txHash: string): Promise<void> {
  await queryRun(
    `UPDATE blockchain_operations
        SET status = $1, tx_hash = $2, attempts = attempts + 1, updated_at = $3
      WHERE id = $4`,
    [OPERATION_STATUS.SUBMITTED, txHash, nowIso(), id]
  );
}

export async function markConfirmed(
  id: number,
  result: { txHash: string; blockNumber: number | null; resultJson?: unknown }
): Promise<void> {
  const now = nowIso();
  await queryRun(
    `UPDATE blockchain_operations
        SET status = $1, tx_hash = $2, block_number = $3, result_json = $4,
            last_error = NULL, updated_at = $5, confirmed_at = $5
      WHERE id = $6`,
    [
      OPERATION_STATUS.CONFIRMED,
      result.txHash,
      result.blockNumber,
      result.resultJson != null ? JSON.stringify(result.resultJson) : null,
      now,
      id,
    ]
  );
}

/**
 * Records a failure. Permanent failures (authorization, validation, duplicate)
 * go straight to Failed so they are never retried blindly; transport-level
 * uncertainty goes to NeedsReconciliation.
 */
export async function markFailed(
  id: number,
  message: string,
  options: { txHash?: string | null; uncertain?: boolean } = {}
): Promise<void> {
  const status =
    options.uncertain && !isPermanentFailure(message)
      ? OPERATION_STATUS.NEEDS_RECONCILIATION
      : OPERATION_STATUS.FAILED;
  await queryRun(
    `UPDATE blockchain_operations
        SET status = $1, last_error = $2, tx_hash = COALESCE($3, tx_hash),
            attempts = attempts + 1, updated_at = $4
      WHERE id = $5`,
    [status, message.slice(0, 1000), options.txHash ?? null, nowIso(), id]
  );
}

export async function getOperation(id: number): Promise<OperationRow | undefined> {
  return queryOne<OperationRow>("SELECT * FROM blockchain_operations WHERE id = $1", [id]);
}

export async function findOperationByIdempotencyKey(key: string): Promise<OperationRow | undefined> {
  return queryOne<OperationRow>("SELECT * FROM blockchain_operations WHERE idempotency_key = $1", [key]);
}

/**
 * Returns an already-confirmed entity for a replayed idempotency key, so a
 * retry returns the original result instead of submitting a second transaction.
 *
 * Each entity table carries a `tx_operation_id` pointing at the outbox row that
 * created it, which is what makes this lookup reliable.
 */
export async function findConfirmedEntityForKey(
  idempotencyKey: string,
  table: "medicine_batches" | "batch_transfers" | "delivery_audit" | "payment_audit"
): Promise<{ id: number } | undefined> {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid table name");
  return queryOne<{ id: number }>(
    `SELECT e.id FROM ${table} e
       JOIN blockchain_operations o ON o.id = e.tx_operation_id
      WHERE o.idempotency_key = $1 AND o.status = $2
      ORDER BY e.id DESC LIMIT 1`,
    [idempotencyKey, OPERATION_STATUS.CONFIRMED]
  );
}

export async function listOperationsForEntity(
  entityType: string,
  entityId: number
): Promise<OperationRow[]> {
  return queryAll<OperationRow>(
    "SELECT * FROM blockchain_operations WHERE entity_type = $1 AND entity_id = $2 ORDER BY id DESC",
    [entityType, entityId]
  );
}

/** Operations stuck Submitted/Pending after a crash or restart. */
export async function listUnsettledOperations(limit = 50): Promise<OperationRow[]> {
  return queryAll<OperationRow>(
    `SELECT * FROM blockchain_operations
      WHERE status IN ($1, $2)
      ORDER BY id ASC LIMIT $3`,
    [OPERATION_STATUS.PENDING, OPERATION_STATUS.SUBMITTED, limit]
  );
}

/**
 * Reconciles unsettled operations by asking the chain what actually happened.
 * Never re-submits: a transaction hash, once sent, is resolved by reading its
 * receipt, which is what keeps retries from double-applying state.
 */
export async function reconcilePending(): Promise<{
  checked: number;
  confirmed: number;
  failed: number;
  stillPending: number;
}> {
  const { getProvider } = await import("./client");
  const rows = await listUnsettledOperations();

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const op of rows) {
    if (!op.tx_hash) {
      // Never reached the chain (process died before send). Safe to retry,
      // but we only mark it for the caller rather than auto-resubmitting.
      await markFailed(op.id, "No transaction hash recorded; never submitted.", { uncertain: true });
      failed++;
      continue;
    }
    try {
      const provider = getProvider();
      const receipt = await provider.getTransactionReceipt(op.tx_hash);
      if (!receipt) {
        stillPending++;
        continue;
      }
      if (receipt.status === 1) {
        await markConfirmed(op.id, { txHash: op.tx_hash, blockNumber: receipt.blockNumber });
        confirmed++;
      } else {
        await markFailed(op.id, "Receipt shows the transaction reverted.", { txHash: op.tx_hash });
        failed++;
      }
    } catch (e) {
      // RPC unreachable: leave it unsettled so a later run can retry.
      stillPending++;
    }
  }

  return { checked: rows.length, confirmed, failed, stillPending };
}
