/**
 * Domain operations that combine the application database (authoritative for
 * stock and workflow state) with the MediMeshLedger contract (authoritative
 * for the audit trail).
 *
 * Invariants:
 *  - The chain never writes to inventory. Stock changes are idempotent and
 *    guarded by a `stock_applied` flag claimed inside one DB transaction.
 *  - No customer PII is hashed or stored. Only opaque refs and catalogue data.
 *  - Every on-chain write goes through the outbox in transactions.ts and is
 *    submitted exactly once.
 */
import type { ethers } from "ethers";
import { queryAll, queryOne, queryRun, queryReturning, nowIso, withTransaction, TxClient } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  getContract,
  getSignerFor,
  sendTx,
  readBatch,
  pharmacyWallet,
  deliveryWallet,
  BlockchainUnavailableError,
  TransactionFailedError,
  describeError,
} from "./client";
import {
  hashBatchMetadata,
  hashRef,
  orderRefForRequest,
  generateOpaqueRef,
  METADATA_SCHEMA_VERSION,
  type BatchMetadata,
} from "./hashes";
import {
  createOperation,
  markSubmitted,
  markConfirmed,
  markFailed,
  findConfirmedEntityForKey,
  OPERATION_TYPE,
} from "./transactions";

export type BatchStatus = "Pending" | "Submitted" | "Registered" | "Revoked" | "Failed" | "NeedsReconciliation";
export type TransferStatus = "Initiated" | "Confirmed" | "Rejected" | "Cancelled" | "Failed";

/** Mirrors MediMeshLedger.Milestone. */
export const MILESTONE_CODE = {
  Packed: 1,
  PickedUp: 2,
  OutForDelivery: 3,
  Delivered: 4,
} as const;
export type MilestoneName = keyof typeof MILESTONE_CODE;

/**
 * Maps the application's existing delivery statuses onto the four on-chain
 * milestones. Missing statuses are simply not audited on-chain.
 */
export const DELIVERY_STATUS_MILESTONE: Record<string, MilestoneName> = {
  Ready: "Packed",
  ArrivedAtPharmacy: "Packed",
  PickedUp: "PickedUp",
  OutForDelivery: "OutForDelivery",
  ArrivedAtDestination: "Delivered",
  Delivered: "Delivered",
};

export interface BatchRow {
  id: number;
  batch_ref: string;
  medicine_id: number;
  pharmacy_id: number;
  quantity_units: number;
  expiry_date: string;
  manufactured_at: string;
  supplier_ref: string;
  metadata_json: string;
  metadata_hash: string;
  batch_id_hash: string;
  status: BatchStatus;
  tx_hash: string | null;
  block_number: number | null;
  registered_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  medicine_name?: string;
  pharmacy_name?: string;
}

const BATCH_SELECT = `
  SELECT b.*, m.name AS medicine_name, p.name AS pharmacy_name
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    JOIN pharmacies p ON p.id = b.pharmacy_id`;

// ---------------------------------------------------------------- batches

export async function listBatches(filter: {
  pharmacyId?: number;
  status?: string;
  limit?: number;
} = {}): Promise<BatchRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.pharmacyId) {
    params.push(filter.pharmacyId);
    where.push(`b.pharmacy_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`b.status = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 300));
  return queryAll<BatchRow>(
    `${BATCH_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY b.id DESC LIMIT $${params.length}`,
    params
  );
}

export async function getBatchById(id: number): Promise<BatchRow | undefined> {
  return queryOne<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1`, [id]);
}

export async function getBatchByRef(batchRef: string): Promise<BatchRow | undefined> {
  return queryOne<BatchRow>(`${BATCH_SELECT} WHERE b.batch_ref = $1`, [batchRef]);
}

export interface RegisterBatchInput {
  pharmacyId: number;
  medicineId: number;
  quantityUnits: number;
  expiryDate: string;
  manufacturedAt: string;
  supplierRef: string;
  batchRef?: string;
  actor: { userId: number; role: string };
  idempotencyKey?: string;
}

/**
 * Registers a medicine batch on-chain.
 *
 * The database row and the outbox operation are committed before submission,
 * so a crash mid-submit leaves a recoverable record rather than an untracked
 * on-chain write.
 */
export async function registerBatch(input: RegisterBatchInput): Promise<BatchRow> {
  // Idempotency first: a replayed key must return the original batch without
  // creating a row or submitting a second transaction.
  if (input.idempotencyKey) {
    const existing = await findConfirmedEntityForKey(input.idempotencyKey, "medicine_batches");
    if (existing) {
      const batch = await getBatchById(existing.id);
      if (batch) return batch;
    }
  }

  const batchRef = input.batchRef ?? generateOpaqueRef("MM");

  if (await getBatchByRef(batchRef)) {
    throw new Error("A batch with this reference already exists.");
  }

  const medicine = await queryOne<{ name: string; salt: string }>(
    "SELECT name, salt FROM medicines WHERE id = $1",
    [input.medicineId]
  );
  if (!medicine) throw new Error("Unknown medicine");

  const metadata: BatchMetadata = {
    schema: METADATA_SCHEMA_VERSION,
    batchRef,
    medicineName: medicine.name,
    salt: medicine.salt,
    medicineId: input.medicineId,
    quantityUnits: input.quantityUnits,
    expiryDate: input.expiryDate,
    pharmacyId: input.pharmacyId,
    manufacturedAt: input.manufacturedAt,
    supplierRef: input.supplierRef,
  };

  const metadataHash = hashBatchMetadata(metadata);
  const batchIdHash = hashRef(batchRef);

  const row = await queryReturning<BatchRow>(
    `INSERT INTO medicine_batches
       (batch_ref, medicine_id, pharmacy_id, quantity_units, expiry_date, manufactured_at,
        supplier_ref, metadata_json, metadata_hash, batch_id_hash, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Pending', $11, $11)
     RETURNING *`,
    [
      batchRef,
      input.medicineId,
      input.pharmacyId,
      input.quantityUnits,
      input.expiryDate,
      input.manufacturedAt,
      input.supplierRef,
      JSON.stringify(metadata),
      metadataHash,
      batchIdHash,
      nowIso(),
    ]
  );
  const batch = row!;

  const op = await createOperation({
    type: OPERATION_TYPE.BATCH_REGISTER,
    entityType: "batch",
    entityId: batch.id,
    idempotencyKey: input.idempotencyKey,
  });

  try {
    const wallet = pharmacyWallet(input.pharmacyId);
    if (!wallet) {
      throw new Error(
        `No local demo wallet is mapped to pharmacy ${input.pharmacyId}. Redeploy with: cd blockchain && npm run deploy`
      );
    }

    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(contract as unknown as ethers.Contract, "registerBatch", [batchIdHash, metadataHash], {
      from: wallet,
      onSubmitted: async (txHash) => {
        await markSubmitted(op.id, txHash);
        await queryRun(
          "UPDATE medicine_batches SET status = 'Submitted', tx_operation_id = $1, updated_at = $2 WHERE id = $3",
          [op.id, nowIso(), batch.id]
        );
      },
    });

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    const registered = await queryOne<BatchRow>(
      `UPDATE medicine_batches
          SET status = 'Registered', tx_hash = $1, block_number = $2, registered_at = $3,
              error = NULL, updated_at = $3
        WHERE id = $4 RETURNING *`,
      [result.txHash, result.blockNumber, nowIso(), batch.id]
    );

    await recordAudit({
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      action: "batch.registered",
      entityType: "batch",
      entityId: batch.id,
      meta: { batchRef, metadataHash, txHash: result.txHash },
    });
    return registered!;
  } catch (e) {
    await failBatch(batch.id, op.id, e);
    throw new Error(describeError(e));
  }
}

async function failBatch(batchId: number, operationId: number, e: unknown): Promise<void> {
  const message = describeError(e);
  const txHash = e instanceof TransactionFailedError ? e.txHash : null;
  const uncertain = txHash != null;
  await markFailed(operationId, message, { txHash, uncertain });
  await queryRun(
    `UPDATE medicine_batches
        SET status = $1, error = $2, tx_operation_id = $3, updated_at = $4
      WHERE id = $5`,
    [uncertain ? "NeedsReconciliation" : "Failed", message, operationId, nowIso(), batchId]
  );
}

/** Revokes a batch. Any authorized pharmacy wallet may report a revocation. */
export async function revokeBatch(
  batchId: number,
  actor: { userId: number; role: string }
): Promise<BatchRow> {
  const batch = await getBatchById(batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.status === "Revoked") throw new Error("Batch is already revoked");

  const op = await createOperation({
    type: OPERATION_TYPE.BATCH_REVOKE,
    entityType: "batch",
    entityId: batchId,
  });

  try {
    const wallet = pharmacyWallet(batch.pharmacy_id);
    if (!wallet) throw new Error(`No local demo wallet mapped to pharmacy ${batch.pharmacy_id}.`);

    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(contract as unknown as ethers.Contract, "revokeBatch", [batch.batch_id_hash], {
      from: wallet,
      onSubmitted: (txHash) => markSubmitted(op.id, txHash),
    });

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    const updated = await queryOne<BatchRow>(
      `UPDATE medicine_batches
          SET status = 'Revoked', tx_hash = $1, block_number = $2, error = NULL, updated_at = $3
        WHERE id = $4 RETURNING *`,
      [result.txHash, result.blockNumber, nowIso(), batchId]
    );
    await recordAudit({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "batch.revoked",
      entityType: "batch",
      entityId: batchId,
      meta: { batchRef: batch.batch_ref, txHash: result.txHash },
    });
    return updated!;
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun("UPDATE medicine_batches SET error = $1, updated_at = $2 WHERE id = $3", [
      message,
      nowIso(),
      batchId,
    ]);
    throw new Error(message);
  }
}

export interface BatchVerification {
  batchRef: string;
  known: boolean;
  status: "REGISTERED" | "REVOKED" | "PENDING" | "NOT_FOUND" | "UNAVAILABLE";
  metadataHash: string | null;
  storedMetadataHash: string | null;
  metadataMatches: boolean | null;
  registeredBy: string | null;
  registeredAt: string | null;
  blockNumber: number | null;
  txHash: string | null;
  pharmacyName: string | null;
  medicineName: string | null;
  quantityUnits: number | null;
  expiryDate: string | null;
  note: string;
}

const VERIFY_NOTE =
  "Blockchain registration confirms that this batch reference and metadata hash were recorded by an authorized " +
  "pharmacy wallet and that no later event revoked them. It does not independently prove the physical medicine is " +
  "genuine or who manufactured it. Trust the registered pharmacy.";

const NOT_FOUND_NOTE =
  "This batch reference has no registration record on the local chain. It may never have been registered, or the " +
  "local chain may have been reset. This is not proof that the medicine is counterfeit.";

/**
 * Verifies a batch by reading actual contract state and recomputing the
 * metadata hash. An unreachable RPC reports UNAVAILABLE, never a negative
 * authenticity claim.
 */
export async function verifyBatchRef(batchRef: string): Promise<BatchVerification> {
  const batch = await getBatchByRef(batchRef);
  const batchIdHash = hashRef(batchRef);

  const base = {
    batchRef,
    known: Boolean(batch),
    metadataHash: null,
    storedMetadataHash: batch?.metadata_hash ?? null,
    metadataMatches: null,
    registeredBy: null,
    registeredAt: null,
    blockNumber: batch?.block_number ?? null,
    txHash: batch?.tx_hash ?? null,
    pharmacyName: batch?.pharmacy_name ?? null,
    medicineName: batch?.medicine_name ?? null,
    quantityUnits: batch?.quantity_units ?? null,
    expiryDate: batch?.expiry_date ?? null,
  };

  let chain: Awaited<ReturnType<typeof readBatch>>;
  try {
    chain = await readBatch(batchIdHash);
  } catch (e) {
    if (e instanceof BlockchainUnavailableError) {
      return { ...base, status: "UNAVAILABLE", note: `Could not reach the local blockchain: ${e.message}` };
    }
    throw e;
  }

  if (!chain.exists) {
    return { ...base, status: "NOT_FOUND", note: NOT_FOUND_NOTE };
  }

  // Recompute locally to prove the stored metadata is unaltered.
  let metadataMatches: boolean | null = null;
  if (batch) {
    try {
      const meta = JSON.parse(batch.metadata_json) as BatchMetadata;
      metadataMatches = hashBatchMetadata(meta) === chain.metadataHash;
    } catch {
      metadataMatches = null;
    }
  }

  const dbPending = batch?.status === "Pending" || batch?.status === "Submitted";
  return {
    ...base,
    status: chain.active ? "REGISTERED" : "REVOKED",
    metadataHash: chain.metadataHash,
    metadataMatches,
    registeredBy: chain.registeredBy,
    registeredAt: chain.registeredAt ? new Date(chain.registeredAt * 1000).toISOString() : null,
    note: dbPending
      ? "The application database still shows this batch as submitting; the chain holds an earlier record."
      : VERIFY_NOTE,
  };
}

// ---------------------------------------------------------------- transfers

export interface TransferRow {
  id: number;
  transfer_ref: string;
  transfer_id_hash: string;
  batch_id: number;
  from_pharmacy_id: number;
  to_pharmacy_id: number;
  quantity: number;
  status: TransferStatus;
  stock_applied: number;
  tx_hash: string | null;
  block_number: number | null;
  confirm_tx_hash: string | null;
  confirm_block_number: number | null;
  reject_reason: string | null;
  error: string | null;
  created_at: string;
  settled_at: string | null;
  batch_ref?: string;
  from_name?: string;
  to_name?: string;
}

// "to" is a reserved word in Postgres, so the destination alias is `dst`.
const TRANSFER_SELECT = `
  SELECT t.*, b.batch_ref, f.name AS from_name, dst.name AS to_name
    FROM batch_transfers t
    JOIN medicine_batches b ON b.id = t.batch_id
    JOIN pharmacies f ON f.id = t.from_pharmacy_id
    JOIN pharmacies dst ON dst.id = t.to_pharmacy_id`;

export async function listTransfers(filter: {
  pharmacyId?: number;
  batchId?: number;
  status?: string;
  limit?: number;
} = {}): Promise<TransferRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.pharmacyId) {
    params.push(filter.pharmacyId);
    where.push(`(t.from_pharmacy_id = $${params.length} OR t.to_pharmacy_id = $${params.length})`);
  }
  if (filter.batchId) {
    params.push(filter.batchId);
    where.push(`t.batch_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`t.status = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 300));
  return queryAll<TransferRow>(
    `${TRANSFER_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.id DESC LIMIT $${params.length}`,
    params
  );
}

export async function getTransferById(id: number): Promise<TransferRow | undefined> {
  return queryOne<TransferRow>(`${TRANSFER_SELECT} WHERE t.id = $1`, [id]);
}

/**
 * Initiates a batch transfer between two pharmacies.
 *
 * Stock moves in Postgres (authoritative) only after the on-chain initiation
 * is confirmed, and only once via the `stock_applied` claim.
 */
export async function initiateTransfer(input: {
  batchId: number;
  fromPharmacyId: number;
  toPharmacyId: number;
  quantity: number;
  actor: { userId: number; role: string };
  idempotencyKey?: string;
}): Promise<TransferRow> {
  // A replayed idempotency key returns the original transfer; it must never
  // move stock a second time or re-submit the on-chain initiation.
  if (input.idempotencyKey) {
    const existing = await findConfirmedEntityForKey(input.idempotencyKey, "batch_transfers");
    if (existing) {
      const row = await getTransferById(existing.id);
      if (row) return row;
    }
  }

  const batch = await getBatchById(input.batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.status !== "Registered") throw new Error("Batch is not registered on-chain");
  if (input.fromPharmacyId === input.toPharmacyId) {
    throw new Error("Source and destination pharmacies must be different");
  }

  const dest = await queryOne<{ id: number; verification_status: string }>(
    "SELECT id, verification_status FROM pharmacies WHERE id = $1",
    [input.toPharmacyId]
  );
  if (!dest) throw new Error("Destination pharmacy not found");
  if (dest.verification_status !== "verified") {
    throw new Error("Destination pharmacy is not verified");
  }

  const sourceWallet = pharmacyWallet(input.fromPharmacyId);
  const destWallet = pharmacyWallet(input.toPharmacyId);
  if (!sourceWallet) throw new Error(`No local demo wallet mapped to pharmacy ${input.fromPharmacyId}.`);
  if (!destWallet) throw new Error(`No local demo wallet mapped to pharmacy ${input.toPharmacyId}.`);

  const transferRef = generateOpaqueRef("TRF");
  const transferIdHash = hashRef(transferRef);

  const row = await queryReturning<TransferRow>(
    `INSERT INTO batch_transfers
       (transfer_ref, transfer_id_hash, batch_id, from_pharmacy_id, to_pharmacy_id, quantity,
        status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Initiated', $7, $7)
     RETURNING *`,
    [transferRef, transferIdHash, input.batchId, input.fromPharmacyId, input.toPharmacyId, input.quantity, nowIso()]
  );
  const transfer = row!;

  const op = await createOperation({
    type: OPERATION_TYPE.TRANSFER_INITIATE,
    entityType: "transfer",
    entityId: transfer.id,
    idempotencyKey: input.idempotencyKey,
  });

  try {
    // The source pharmacy signs: initiateTransfer must come from the source
    // wallet, and the contract re-checks the role.
    const contract = getContract(getSignerFor(sourceWallet));
    const result = await sendTx(
      contract as unknown as ethers.Contract,
      "initiateTransfer",
      [transferIdHash, batch.batch_id_hash, destWallet, input.quantity],
      {
        from: sourceWallet,
        onSubmitted: async (txHash) => {
          await markSubmitted(op.id, txHash);
          await queryRun("UPDATE batch_transfers SET tx_operation_id = $1, updated_at = $2 WHERE id = $3", [
            op.id,
            nowIso(),
            transfer.id,
          ]);
        },
      }
    );

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    await applyTransferStock(transfer, batch, input.actor, result);
    return (await getTransferById(transfer.id))!;
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun("UPDATE batch_transfers SET status = 'Failed', error = $1, updated_at = $2 WHERE id = $3", [
      message,
      nowIso(),
      transfer.id,
    ]);
    throw new Error(message);
  }
}

/**
 * Applies the batch quantity movement to inventory exactly once.
 *
 * The claim `status='Initiated' AND stock_applied=0 -> 1` happens in the same
 * UPDATE, inside one transaction, so concurrent retries cannot double-apply.
 */
async function applyTransferStock(
  transfer: TransferRow,
  batch: BatchRow,
  actor: { userId: number; role: string },
  result: { txHash: string; blockNumber: number | null }
): Promise<void> {
  const now = nowIso();

  const claimed = await withTransaction(async (tx: TxClient) => {
    const changed = await tx.run(
      `UPDATE batch_transfers
          SET stock_applied = 1, tx_hash = $1, block_number = $2, error = NULL, updated_at = $3
        WHERE id = $4 AND status = 'Initiated' AND stock_applied = 0`,
      [result.txHash, result.blockNumber, now, transfer.id]
    );
    if (changed !== 1) return false;

    await tx.run(
      `UPDATE inventory
          SET qty_total = GREATEST(qty_locked, qty_total - $1)
        WHERE pharmacy_id = $2 AND medicine_id = $3 AND qty_total - qty_locked >= $1`,
      [transfer.quantity, transfer.from_pharmacy_id, batch.medicine_id]
    );
    await tx.run(
      `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked, expiry_date)
       VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (pharmacy_id, medicine_id)
       DO UPDATE SET qty_total = inventory.qty_total + excluded.qty_total`,
      [transfer.to_pharmacy_id, batch.medicine_id, transfer.quantity, batch.expiry_date]
    );
    return true;
  });

  // Already applied by an earlier attempt — deliberate no-op, not an error.
  if (!claimed) return;

  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "transfer.initiated",
    entityType: "transfer",
    entityId: transfer.id,
    meta: { transferRef: transfer.transfer_ref, quantity: transfer.quantity, txHash: result.txHash },
  });
}

function assertTransferActor(
  actor: { userId: number; role: string },
  allowedRoles: string[]
): void {
  if (!allowedRoles.includes(actor.role)) {
    throw new Error("Only an authorized pharmacy user can settle a transfer");
  }
}

/** Destination pharmacy confirms receipt of a transfer. */
export async function confirmTransfer(
  transferId: number,
  actor: { userId: number; role: string }
): Promise<TransferRow> {
  assertTransferActor(actor, ["pharmacy_owner", "pharmacy_staff", "admin"]);

  const transfer = await getTransferById(transferId);
  if (!transfer) throw new Error("Transfer not found");
  if (transfer.status !== "Initiated") throw new Error(`Transfer is already ${transfer.status}`);

  const wallet = pharmacyWallet(transfer.to_pharmacy_id);
  if (!wallet) throw new Error(`No local demo wallet mapped to pharmacy ${transfer.to_pharmacy_id}.`);

  const op = await createOperation({
    type: OPERATION_TYPE.TRANSFER_CONFIRM,
    entityType: "transfer",
    entityId: transferId,
  });

  try {
    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(contract as unknown as ethers.Contract, "confirmTransfer", [transfer.transfer_id_hash], {
      from: wallet,
      onSubmitted: (txHash) => markSubmitted(op.id, txHash),
    });

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    const updated = await queryOne<TransferRow>(
      `UPDATE batch_transfers
          SET status = 'Confirmed', confirm_tx_hash = $1, confirm_block_number = $2,
              settled_at = $3, updated_at = $3, confirm_operation_id = $4
        WHERE id = $5 RETURNING *`,
      [result.txHash, result.blockNumber, nowIso(), op.id, transferId]
    );
    await recordAudit({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "transfer.confirmed",
      entityType: "transfer",
      entityId: transferId,
      meta: { txHash: result.txHash },
    });
    return updated!;
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun("UPDATE batch_transfers SET error = $1, updated_at = $2 WHERE id = $3", [
      message,
      nowIso(),
      transferId,
    ]);
    throw new Error(message);
  }
}

/** Destination pharmacy rejects a transfer. No stock ever moved, so no reversal. */
export async function rejectTransfer(
  transferId: number,
  reason: string,
  actor: { userId: number; role: string }
): Promise<TransferRow> {
  assertTransferActor(actor, ["pharmacy_owner", "pharmacy_staff", "admin"]);

  const transfer = await getTransferById(transferId);
  if (!transfer) throw new Error("Transfer not found");
  if (transfer.status !== "Initiated") throw new Error(`Transfer is already ${transfer.status}`);

  const wallet = pharmacyWallet(transfer.to_pharmacy_id);
  if (!wallet) throw new Error(`No local demo wallet mapped to pharmacy ${transfer.to_pharmacy_id}.`);

  const op = await createOperation({
    type: OPERATION_TYPE.TRANSFER_REJECT,
    entityType: "transfer",
    entityId: transferId,
  });

  try {
    const reasonHash = hashRef(reason.slice(0, 200));
    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(
      contract as unknown as ethers.Contract,
      "rejectTransfer",
      [transfer.transfer_id_hash, reasonHash],
      { from: wallet, onSubmitted: (txHash) => markSubmitted(op.id, txHash) }
    );

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    return (
      (await queryOne<TransferRow>(
        `UPDATE batch_transfers
            SET status = 'Rejected', reject_reason = $1, settled_at = $2, confirm_tx_hash = $3,
                confirm_block_number = $4, updated_at = $2
          WHERE id = $5 RETURNING *`,
        [reason.slice(0, 200), nowIso(), result.txHash, result.blockNumber, transferId]
      ))!
    );
  } catch (e) {
    const message = describeError(e);
    await markFailed(op.id, message, {});
    await queryRun("UPDATE batch_transfers SET error = $1, updated_at = $2 WHERE id = $3", [
      message,
      nowIso(),
      transferId,
    ]);
    throw new Error(message);
  }
}

// ---------------------------------------------------------------- deliveries

export interface DeliveryAuditRow {
  id: number;
  delivery_id: number;
  order_ref: string;
  order_ref_hash: string;
  milestone: string;
  milestone_code: number;
  actor_user_id: number | null;
  actor_role: string;
  actor_wallet: string | null;
  tx_hash: string | null;
  block_number: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export async function listDeliveryAudit(deliveryId: number): Promise<DeliveryAuditRow[]> {
  return queryAll<DeliveryAuditRow>(
    "SELECT * FROM delivery_audit WHERE delivery_id = $1 ORDER BY milestone_code ASC",
    [deliveryId]
  );
}

/**
 * Stable opaque order reference. Derived from the internal request id with a
 * server-side secret-free domain separator, so it is stable across restarts and
 * reveals no customer data.
 */
export async function getOrderRefForRequest(requestId: number): Promise<string> {
  const existing = await queryOne<{ order_ref: string }>(
    `SELECT order_ref FROM delivery_audit
      WHERE delivery_id IN (SELECT id FROM deliveries WHERE request_id = $1) LIMIT 1`,
    [requestId]
  );
  return existing?.order_ref ?? orderRefForRequest(requestId);
}

/**
 * Records a delivery milestone on-chain.
 *
 * Idempotent: an already-Recorded milestone returns the existing row without
 * touching the chain.
 */
export async function recordDeliveryMilestone(input: {
  deliveryId: number;
  milestone: MilestoneName;
  actor: { userId: number; role: string };
}): Promise<DeliveryAuditRow> {
  const delivery = await queryOne<{
    id: number;
    request_id: number;
    status: string;
    partner_id: number | null;
    pharmacy_id: number;
  }>("SELECT id, request_id, status, partner_id, pharmacy_id FROM deliveries WHERE id = $1", [input.deliveryId]);
  if (!delivery) throw new Error("Delivery not found");

  const code = MILESTONE_CODE[input.milestone];
  const orderRef = await getOrderRefForRequest(delivery.request_id);
  const orderRefHash = hashRef(orderRef);

  const existing = await queryOne<DeliveryAuditRow>(
    "SELECT * FROM delivery_audit WHERE delivery_id = $1 AND milestone = $2",
    [input.deliveryId, input.milestone]
  );
  if (existing?.status === "Recorded") return existing;

  if (existing) {
    await queryRun(
      "UPDATE delivery_audit SET status = 'Pending', error = NULL, actor_user_id = $1, actor_role = $2 WHERE id = $3",
      [input.actor.userId, input.actor.role, existing.id]
    );
  } else {
    await queryRun(
      `INSERT INTO delivery_audit
         (delivery_id, order_ref, order_ref_hash, milestone, milestone_code, actor_user_id, actor_role, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)`,
      [input.deliveryId, orderRef, orderRefHash, input.milestone, code, input.actor.userId, input.actor.role, nowIso()]
    );
  }

  const auditRow = (
    await queryOne<DeliveryAuditRow>("SELECT * FROM delivery_audit WHERE delivery_id = $1 AND milestone = $2", [
      input.deliveryId,
      input.milestone,
    ])
  )!;

  // The acting wallet: a delivery partner if assigned, otherwise the owning
  // pharmacy (which may record Packed). The contract re-checks authorization.
  const wallet = resolveMilestoneActorWallet(delivery, input.actor, input.milestone);
  if (!wallet) {
    const message = `No local demo wallet is mapped for this actor (user ${input.actor.userId}).`;
    await queryRun("UPDATE delivery_audit SET status = 'Failed', error = $1 WHERE id = $2", [message, auditRow.id]);
    throw new Error(message);
  }

  const op = await createOperation({
    type: OPERATION_TYPE.DELIVERY_MILESTONE,
    entityType: "delivery",
    entityId: input.deliveryId,
  });

  try {
    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(contract as unknown as ethers.Contract, "recordDeliveryEvent", [orderRefHash, code], {
      from: wallet,
      onSubmitted: async (txHash) => {
        await markSubmitted(op.id, txHash);
        await queryRun("UPDATE delivery_audit SET tx_operation_id = $1 WHERE id = $2", [op.id, auditRow.id]);
      },
    });

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    return (
      (await queryOne<DeliveryAuditRow>(
        `UPDATE delivery_audit
            SET status = 'Recorded', tx_hash = $1, block_number = $2, actor_wallet = $3, error = NULL
          WHERE id = $4 RETURNING *`,
        [result.txHash, result.blockNumber, wallet, auditRow.id]
      ))!
    );
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun("UPDATE delivery_audit SET status = 'Failed', error = $1 WHERE id = $2", [
      message,
      auditRow.id,
    ]);
    throw new Error(message);
  }
}

/**
 * Chooses the signing wallet for a milestone.
 *
 * Delivery partners use their mapped delivery wallet; a pharmacy wallet is used
 * for the Packed milestone. The contract still enforces the role check, so this
 * mapping never grants privilege it should not have.
 */
function resolveMilestoneActorWallet(
  delivery: { id: number; partner_id: number | null; pharmacy_id: number },
  actor: { role: string },
  milestone: MilestoneName
): string | null {
  // A delivery partner signs with the wallet mapped to their partner id.
  if (actor.role === "delivery_partner") {
    if (delivery.partner_id == null) return null;
    return deliveryWallet(delivery.partner_id);
  }
  // The fulfilling pharmacy may record the packing milestone.
  if (milestone === "Packed" && (actor.role === "pharmacy_owner" || actor.role === "pharmacy_staff")) {
    return pharmacyWallet(delivery.pharmacy_id);
  }
  // Admins do not sign milestone transactions — an authorized actor must.
  return null;
}
