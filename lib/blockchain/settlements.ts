/**
 * On-chain settlement audit.
 *
 * Anchors one event per paid-out payment: "an authorized actor reported that
 * amount A for order B was routed to pharmacy wallet C".
 *
 * What this does and does not prove, stated precisely because the difference
 * matters to anyone reading the receipt:
 *
 *   proves   - the report was signed by a wallet holding PHARMACY_ROLE and was
 *              immutable from block N onward;
 *   does not prove - that money actually moved. The contract never touches a
 *              payment instrument; the gateway did. This is an attestation of
 *              a reported event, never a bank statement.
 *
 * Like every other write in this layer, it is idempotent and goes through the
 * durable outbox: the audit row is persisted before any submission, so an
 * uncertain outcome is reconciled rather than blindly resubmitted.
 */
import type { ethers } from "ethers";
import {
  BlockchainUnavailableError,
  TransactionFailedError,
  deliveryWallet,
  describeError,
  getContract,
  getSignerFor,
  pharmacyWallet,
  sendTx,
} from "./client";
import { getOrderRefForRequest } from "./ledger";
import {
  generateOpaqueRef,
  hashRef,
  hashRiderSettlementMetadata,
  hashSettlementMetadata,
  METADATA_SCHEMA_VERSION,
  type RiderSettlementMetadata,
  type SettlementMetadata,
} from "./hashes";
import {
  OPERATION_TYPE,
  createOperation,
  markConfirmed,
  markFailed,
  markSubmitted,
} from "./transactions";
import { nowIso, queryOne, queryRun } from "@/lib/db";
import type { PaymentAuditRow, PaymentRow } from "@/lib/payments";

/**
 * Persists the settlement audit row (if absent) and submits it on-chain.
 *
 * Re-running after a confirmed anchor returns the existing row untouched, so
 * both order-completion paths can call this freely.
 */
export async function recordSettlementOnChain(
  paymentId: number,
  actor: { userId: number; role: string }
): Promise<PaymentAuditRow> {
  const payment = await queryOne<PaymentRow>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  if (!payment) throw new Error("Payment not found");
  if (payment.pharmacy_id == null) throw new Error("Payment has no pharmacy to credit");

  const existing = await queryOne<PaymentAuditRow>("SELECT * FROM payment_audit WHERE payment_id = $1", [
    paymentId,
  ]);
  // Already anchored on-chain: nothing left to do.
  if (existing?.status === "Settled") return existing;

  const settledAt = payment.settled_at ?? payment.paid_out_at ?? payment.captured_at ?? nowIso();
  const orderRef = await getOrderRefForRequest(payment.request_id);

  // Opaque references are generated once and stored, so a retry hashes the
  // same values a verifier will recompute later.
  const settlementRef = existing?.settlement_ref ?? generateOpaqueRef("SET");
  const settlementRefHash = hashRef(settlementRef);
  const orderRefHash = hashRef(orderRef);
  // The gateway reference is a transfer id, not an instrument detail; it is
  // hashed rather than stored so no merchant-side identifier leaks on-chain.
  const gatewayRef = payment.razorpay_transfer_id ?? payment.razorpay_payment_id ?? "unrouted";
  // The canonical metadata is stored verbatim (as with batches) so a verifier
  // can recompute the hash later instead of taking our word for it.
  const metadata: SettlementMetadata = {
    schema: METADATA_SCHEMA_VERSION,
    settlementRef,
    orderRef,
    pharmacyId: payment.pharmacy_id,
    amountPaise: payment.pharmacy_amount_paise,
    gatewayRef,
    settledAt,
  };
  const metadataJson = JSON.stringify(metadata);
  const metadataHash = hashSettlementMetadata(metadata);

  let auditRow = existing;
  if (auditRow) {
    auditRow = (
      await queryOne<PaymentAuditRow>(
        `UPDATE payment_audit
            SET status = 'Pending', error = NULL, metadata_hash = $1, gateway_ref_hash = $2,
                metadata_json = $3, actor_user_id = $4, actor_role = $5, updated_at = $6
          WHERE id = $7 RETURNING *`,
        [
          metadataHash,
          hashRef(gatewayRef),
          metadataJson,
          actor.userId,
          actor.role,
          nowIso(),
          auditRow.id,
        ]
      )
    )!;
  } else {
    auditRow = (
      await queryOne<PaymentAuditRow>(
        `INSERT INTO payment_audit
           (payment_id, settlement_ref, settlement_ref_hash, order_ref, order_ref_hash, amount_paise,
            beneficiary_wallet, pharmacy_id, actor_user_id, actor_role, gateway_ref_hash, metadata_hash,
            metadata_json, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'Pending', $14, $14)
         RETURNING *`,
        [
          paymentId,
          settlementRef,
          settlementRefHash,
          orderRef,
          orderRefHash,
          payment.pharmacy_amount_paise,
          pharmacyWallet(payment.pharmacy_id),
          payment.pharmacy_id,
          actor.userId,
          actor.role,
          hashRef(gatewayRef),
          metadataHash,
          metadataJson,
          nowIso(),
        ]
      )
    )!;
  }

  // The beneficiary wallet must be an authorized pharmacy on-chain, so the
  // signed wallet is the pharmacy's own mapped wallet.
  const wallet = pharmacyWallet(payment.pharmacy_id);
  if (!wallet) {
    const message = `No blockchain wallet is mapped for pharmacy ${payment.pharmacy_id}.`;
    await queryRun("UPDATE payment_audit SET status = 'Failed', error = $1 WHERE id = $2", [
      message,
      auditRow.id,
    ]);
    throw new Error(message);
  }

  const op = await createOperation({
    type: OPERATION_TYPE.PAYMENT_SETTLE,
    entityType: "payment",
    entityId: paymentId,
  });

  try {
    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(
      contract as unknown as ethers.Contract,
      "recordSettlement",
      [settlementRefHash, orderRefHash, metadataHash, payment.pharmacy_amount_paise, wallet],
      {
        from: wallet,
        onSubmitted: async (txHash) => {
          await markSubmitted(op.id, txHash);
          await queryRun(
            "UPDATE payment_audit SET tx_operation_id = $1, status = 'Submitted' WHERE id = $2",
            [op.id, auditRow.id]
          );
        },
      }
    );

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    return (
      (await queryOne<PaymentAuditRow>(
        `UPDATE payment_audit
            SET status = 'Settled', tx_hash = $1, block_number = $2, error = NULL, settled_at = $3,
                updated_at = $3
          WHERE id = $4 RETURNING *`,
        [result.txHash, result.blockNumber, nowIso(), auditRow.id]
      ))!
    );
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun(
      `UPDATE payment_audit
          SET status = $1, error = $2, updated_at = $3
        WHERE id = $4`,
      [txHash != null ? "NeedsReconciliation" : "Failed", message.slice(0, 1000), nowIso(), auditRow.id]
    );
    throw new Error(message);
  }
}

/**
 * The wallet a rider signs and receives on.
 *
 * Read from the user row, not inferred from the deployment manifest: the
 * manifest is keyed by Hardhat account slot and knows nothing about the ids the
 * database assigned, so every lookup there failed for perfectly real riders. The
 * manifest is still consulted as a fallback for a deployment whose users were
 * never mapped.
 */
async function riderChainWallet(riderUserId: number): Promise<string | null> {
  const row = await queryOne<{ chain_wallet: string | null }>(
    "SELECT chain_wallet FROM users WHERE id = $1",
    [riderUserId]
  );
  return row?.chain_wallet ?? deliveryWallet(riderUserId);
}

/**
 * Anchors the rider's delivery-fee settlement.
 *
 * A separate anchor from the pharmacy's, with its own reference and its own
 * replay guard: the fee is a different payment to a different party, so a
 * dispute or correction about one must not invalidate the other's proof.
 *
 * The beneficiary must hold DELIVERY_ROLE on-chain, so only an authorized rider
 * wallet can be named as the recipient.
 */
export async function recordRiderSettlementOnChain(
  paymentId: number,
  riderUserId: number,
  actor: { userId: number; role: string }
): Promise<PaymentAuditRow> {
  const payment = await queryOne<PaymentRow>("SELECT * FROM payments WHERE id = $1", [paymentId]);
  if (!payment) throw new Error("Payment not found");
  if (payment.rider_amount_paise <= 0) throw new Error("Payment has no rider share");

  const existing = await queryOne<PaymentAuditRow>(
    "SELECT * FROM payment_audit WHERE payment_id = $1 AND kind = 'rider'",
    [paymentId]
  );
  if (existing?.status === "Settled") return existing;

  const settledAt = payment.rider_paid_out_at ?? nowIso();
  const orderRef = await getOrderRefForRequest(payment.request_id);
  const settlementRef = existing?.settlement_ref ?? generateOpaqueRef("RDR");
  const settlementRefHash = hashRef(settlementRef);
  const orderRefHash = hashRef(orderRef);
  const gatewayRef = payment.rider_transfer_id ?? "unrouted";

  const metadata: RiderSettlementMetadata = {
    schema: METADATA_SCHEMA_VERSION,
    settlementRef,
    orderRef,
    riderUserId,
    amountPaise: payment.rider_amount_paise,
    requestId: payment.request_id,
    gatewayRef,
    settledAt,
  };
  const metadataJson = JSON.stringify(metadata);
  const metadataHash = hashRiderSettlementMetadata(metadata);

  let auditRow = existing;
  if (auditRow) {
    auditRow = (
      await queryOne<PaymentAuditRow>(
        `UPDATE payment_audit
            SET status = 'Pending', error = NULL, metadata_hash = $1, gateway_ref_hash = $2,
                metadata_json = $3, rider_user_id = $4, actor_user_id = $5, actor_role = $6,
                updated_at = $7
          WHERE id = $8 RETURNING *`,
        [
          metadataHash,
          hashRef(gatewayRef),
          metadataJson,
          riderUserId,
          actor.userId,
          actor.role,
          nowIso(),
          auditRow.id,
        ]
      )
    )!;
  } else {
    auditRow = (
      await queryOne<PaymentAuditRow>(
        `INSERT INTO payment_audit
           (payment_id, kind, rider_user_id, settlement_ref, settlement_ref_hash, order_ref,
            order_ref_hash, amount_paise, beneficiary_wallet, actor_user_id, actor_role,
            gateway_ref_hash, metadata_hash, metadata_json, status, created_at, updated_at)
         VALUES ($1, 'rider', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'Pending', $14, $14)
         RETURNING *`,
        [
          paymentId,
          riderUserId,
          settlementRef,
          settlementRefHash,
          orderRef,
          orderRefHash,
          payment.rider_amount_paise,
          deliveryWallet(riderUserId),
          actor.userId,
          actor.role,
          hashRef(gatewayRef),
          metadataHash,
          metadataJson,
          nowIso(),
        ]
      )
    )!;
  }

  const wallet = await riderChainWallet(riderUserId);
  if (!wallet) {
    const message =
      `No blockchain wallet is mapped for rider ${riderUserId}. ` +
      `Run: npm run chain:map-wallets`;
    await queryRun("UPDATE payment_audit SET status = 'Failed', error = $1 WHERE id = $2", [
      message,
      auditRow.id,
    ]);
    throw new Error(message);
  }

  const op = await createOperation({
    type: OPERATION_TYPE.PAYMENT_SETTLE,
    entityType: "rider_payout",
    entityId: paymentId,
  });

  try {
    const contract = getContract(getSignerFor(wallet));
    const result = await sendTx(
      contract as unknown as ethers.Contract,
      "recordRiderSettlement",
      [settlementRefHash, orderRefHash, metadataHash, payment.rider_amount_paise, wallet],
      {
        from: wallet,
        onSubmitted: async (txHash) => {
          await markSubmitted(op.id, txHash);
          await queryRun(
            "UPDATE payment_audit SET tx_operation_id = $1, status = 'Submitted' WHERE id = $2",
            [op.id, auditRow.id]
          );
        },
      }
    );

    await markConfirmed(op.id, { txHash: result.txHash, blockNumber: result.blockNumber });
    return (
      (await queryOne<PaymentAuditRow>(
        `UPDATE payment_audit
            SET status = 'Settled', tx_hash = $1, block_number = $2, error = NULL, settled_at = $3,
                updated_at = $3
          WHERE id = $4 RETURNING *`,
        [result.txHash, result.blockNumber, nowIso(), auditRow.id]
      ))!
    );
  } catch (e) {
    const message = describeError(e);
    const txHash = e instanceof TransactionFailedError ? e.txHash : null;
    await markFailed(op.id, message, { txHash, uncertain: txHash != null });
    await queryRun(
      `UPDATE payment_audit
          SET status = $1, error = $2, updated_at = $3
        WHERE id = $4`,
      [txHash != null ? "NeedsReconciliation" : "Failed", message.slice(0, 1000), nowIso(), auditRow.id]
    );
    throw new Error(message);
  }
}

/**
 * Reads a settlement back from the chain and compares it with the stored
 * metadata hash. Used by the verify endpoint; proves the anchored value has
 * not drifted from what this system recorded.
 */
export async function verifySettlementOnChain(
  paymentId: number
): Promise<{
  exists: boolean;
  matches: boolean;
  amountPaise: number | null;
  /** Unix seconds, from the contract's `settledAt`. Not a block number. */
  settledAtUnix: number | null;
  /** Block the anchoring transaction landed in, from the stored receipt. */
  blockNumber: number | null;
}> {
  const audit = await queryOne<PaymentAuditRow>("SELECT * FROM payment_audit WHERE payment_id = $1", [
    paymentId,
  ]);
  if (!audit)
    return { exists: false, matches: false, amountPaise: null, settledAtUnix: null, blockNumber: null };
  const contract = getContract() as unknown as ethers.Contract;
  const result = (await contract.getSettlement(audit.settlement_ref_hash)) as {
    amountPaise: bigint;
    settlementHash: string;
    settledAt: bigint;
  };
  const settledAt = Number(result.settledAt);
  return {
    exists: settledAt > 0,
    matches: result.settlementHash.toLowerCase() === audit.metadata_hash.toLowerCase(),
    amountPaise: Number(result.amountPaise),
    settledAtUnix: settledAt > 0 ? settledAt : null,
    blockNumber: audit.block_number,
  };
}

// ---------------------------------------------------------------- public view

export type SettlementVerificationStatus =
  | "SETTLED"
  | "PENDING"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "MISMATCH";

export interface SettlementVerification {
  settlementRef: string;
  status: SettlementVerificationStatus;
  orderRef: string;
  amountPaise: number;
  pharmacyName: string | null;
  beneficiaryWallet: string | null;
  settledAtUnix: number | null;
  metadataHash: string | null;
  /** Recomputed locally from stored metadata; true means the record is unaltered. */
  metadataMatches: boolean | null;
  txHash: string | null;
  blockNumber: number | null;
  note: string;
}

const SETTLED_NOTE =
  "An authorised pharmacy wallet recorded that this amount was routed to it for this order, and the metadata " +
  "anchored on-chain still matches what MediMesh holds — so the record has not been altered since. It does NOT " +
  "prove a bank transfer occurred: the chain has no visibility into the payment rail. The payment gateway is the " +
  "evidence that money moved.";

const NOT_FOUND_NOTE =
  "No settlement with this reference exists on the chain. It may never have been recorded, or the chain may have " +
  "been reset. This is not evidence that a pharmacy withheld a payment — ask the customer or pharmacy for the " +
  "receipt reference.";

const PENDING_NOTE =
  "MediMesh has recorded this payout in its database but the on-chain anchor has not confirmed yet. This usually " +
  "means the local blockchain was unreachable when the order was completed. It will appear on the chain once the " +
  "pending write is reconciled.";

/**
 * Verifies a settlement for a public, unauthenticated viewer.
 *
 * Three independent checks, so the page is not just restating our own database:
 *   1. the reference hashes to a settlement that exists on-chain;
 *   2. the on-chain metadata hash equals a hash recomputed here from the stored
 *      canonical metadata (proving the stored record is unaltered);
 *   3. the on-chain beneficiary and amount are reported for display, not
 *      treated as proof of anything beyond "this was reported".
 *
 * An unreachable chain reports UNAVAILABLE. It never turns into a negative
 * claim about a pharmacy's honesty.
 */
export async function verifySettlementRef(settlementRef: string): Promise<SettlementVerification> {
  const audit = await queryOne<PaymentAuditRow & { pharmacy_name: string | null }>(
    `SELECT pa.*, p.name AS pharmacy_name
       FROM payment_audit pa
       LEFT JOIN pharmacies p ON p.id = pa.pharmacy_id
      WHERE pa.settlement_ref = $1`,
    [settlementRef]
  );

  const base: SettlementVerification = {
    settlementRef,
    status: "NOT_FOUND",
    orderRef: audit?.order_ref ?? "",
    amountPaise: audit?.amount_paise ?? 0,
    pharmacyName: audit?.pharmacy_name ?? null,
    beneficiaryWallet: audit?.beneficiary_wallet ?? null,
    settledAtUnix: null,
    metadataHash: audit?.metadata_hash ?? null,
    metadataMatches: null,
    txHash: audit?.tx_hash ?? null,
    blockNumber: audit?.block_number ?? null,
    note: NOT_FOUND_NOTE,
  };
  if (!audit) return base;

  const settlementRefHash = hashRef(settlementRef);
  let onChain: { amountPaise: bigint; settlementHash: string; beneficiary: string; settledAt: bigint };
  try {
    const contract = getContract() as unknown as ethers.Contract;
    onChain = (await contract.getSettlement(settlementRefHash)) as typeof onChain;
  } catch (e) {
    if (e instanceof BlockchainUnavailableError) {
      return { ...base, status: "UNAVAILABLE", note: `Could not reach the chain: ${e.message}` };
    }
    throw e;
  }

  if (Number(onChain.settledAt) === 0) {
    return {
      ...base,
      status: audit.status === "Settled" ? "NOT_FOUND" : "PENDING",
      note: audit.status === "Settled" ? NOT_FOUND_NOTE : PENDING_NOTE,
    };
  }

  // Recompute from the stored canonical metadata rather than trusting the
  // stored hash column.
  let metadataMatches: boolean | null = null;
  if (audit.metadata_json) {
    try {
      metadataMatches =
        hashSettlementMetadata(JSON.parse(audit.metadata_json) as SettlementMetadata) ===
        onChain.settlementHash.toLowerCase();
    } catch {
      metadataMatches = null;
    }
  }

  const amountMatches = Number(onChain.amountPaise) === audit.amount_paise;
  const beneficiaryMatches =
    !audit.beneficiary_wallet ||
    onChain.beneficiary.toLowerCase() === audit.beneficiary_wallet.toLowerCase();

  if (metadataMatches === false || !amountMatches || !beneficiaryMatches) {
    return {
      ...base,
      status: "MISMATCH",
      amountPaise: Number(onChain.amountPaise),
      beneficiaryWallet: onChain.beneficiary,
      settledAtUnix: Number(onChain.settledAt),
      metadataHash: onChain.settlementHash,
      metadataMatches,
      note:
        "The chain record does not agree with what MediMesh holds. Treat this settlement as disputed and escalate " +
        "to the pharmacy — do not pay out against it.",
    };
  }

  return {
    ...base,
    status: "SETTLED",
    amountPaise: Number(onChain.amountPaise),
    beneficiaryWallet: onChain.beneficiary,
    settledAtUnix: Number(onChain.settledAt),
    metadataHash: onChain.settlementHash,
    metadataMatches,
    note: SETTLED_NOTE,
  };
}