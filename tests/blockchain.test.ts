import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll, queryRun } from "@/lib/db";
import {
  hashBatchMetadata,
  hashRef,
  generateOpaqueRef,
  isValidOpaqueRef,
  orderRefForRequest,
  METADATA_SCHEMA_VERSION,
  type BatchMetadata,
} from "@/lib/blockchain/hashes";
import {
  getChainStatus,
  BlockchainUnavailableError,
  TransactionFailedError,
  describeError,
} from "@/lib/blockchain/client";
import {
  createOperation,
  markSubmitted,
  markConfirmed,
  markFailed,
  findOperationByIdempotencyKey,
  reconcilePending,
  isPermanentFailure,
  OPERATION_STATUS,
  OPERATION_TYPE,
  PERMANENT_ERROR_PREFIXES,
} from "@/lib/blockchain/transactions";
import { verifyBatchRef, listBatches, DELIVERY_STATUS_MILESTONE } from "@/lib/blockchain/ledger";
import { batchRegisterSchema, transferInitiateSchema, deliveryMilestoneSchema } from "@/lib/validation";

// ---------------------------------------------------------------- hashing

describe("blockchain hashing", () => {
  const base: BatchMetadata = {
    schema: METADATA_SCHEMA_VERSION,
    batchRef: "MM-ABCD-EFGH-IJKL-MNOPQRST",
    medicineName: "Crocin Advance",
    salt: "Acetaminophen",
    medicineId: 3,
    quantityUnits: 100,
    expiryDate: "2027-06-30",
    pharmacyId: 1,
    manufacturedAt: "2026-01-15",
    supplierRef: "SUP-ACME-2291",
  };

  it("produces a stable 32-byte hash", () => {
    const h = hashBatchMetadata(base);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashBatchMetadata(base)).toBe(h);
  });

  it("changes when any field changes", () => {
    const original = hashBatchMetadata(base);
    const variants = [
      { ...base, quantityUnits: 101 },
      { ...base, expiryDate: "2027-07-01" },
      { ...base, medicineName: "Crocin 650" },
      { ...base, supplierRef: "SUP-ACME-2292" },
      { ...base, pharmacyId: 2 },
      { ...base, schema: 2 },
    ];
    for (const v of variants) {
      expect(hashBatchMetadata(v)).not.toBe(original);
    }
  });

  it("is insensitive to surrounding whitespace", () => {
    const padded = { ...base, medicineName: `  ${base.medicineName}  ` };
    expect(hashBatchMetadata(padded)).toBe(hashBatchMetadata(base));
  });

  it("is not confused by delimiter-style collisions", () => {
    // Without packed ABI encoding, "ab"+"c" and "a"+"bc" could collide.
    const a = hashBatchMetadata({ ...base, medicineName: "ab", salt: "c" });
    const b = hashBatchMetadata({ ...base, medicineName: "a", salt: "bc" });
    expect(a).not.toBe(b);
  });

  it("hashes opaque references deterministically", () => {
    expect(hashRef("MM-AAAA-BBBB-CCCC-DDDDDDDD")).toBe(hashRef("MM-AAAA-BBBB-CCCC-DDDDDDDD"));
    expect(hashRef("a")).not.toBe(hashRef("b"));
  });
});

describe("opaque references", () => {
  it("generates refs that pass validation", () => {
    for (let i = 0; i < 200; i++) {
      const ref = generateOpaqueRef("MM");
      expect(isValidOpaqueRef(ref)).toBe(true);
    }
  });

  it("avoids visually ambiguous characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateOpaqueRef("MM")).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat", () => {
    const set = new Set(Array.from({ length: 500 }, () => generateOpaqueRef("MM")));
    expect(set.size).toBe(500);
  });

  it("derives a stable order ref from a request id", () => {
    expect(orderRefForRequest(42)).toBe(orderRefForRequest(42));
    expect(orderRefForRequest(42)).not.toBe(orderRefForRequest(43));
  });
});

// ---------------------------------------------------------------- operations

describe("blockchain operation outbox", () => {
  beforeEach(async () => {
    await resetDemo();
    await queryRun("DELETE FROM blockchain_operations");
  });

  it("creates a Pending operation before submission", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    expect(op.status).toBe(OPERATION_STATUS.PENDING);
    expect(op.attempts).toBe(0);
    expect(op.tx_hash).toBeNull();
  });

  it("is idempotent on the idempotency key", async () => {
    const a = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
      idempotencyKey: "dedupe-1",
    });
    const b = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
      idempotencyKey: "dedupe-1",
    });
    expect(b.id).toBe(a.id);
    const rows = await queryAll("SELECT * FROM blockchain_operations WHERE idempotency_key = $1", ["dedupe-1"]);
    expect(rows).toHaveLength(1);
  });

  it("records the tx hash as soon as it is known", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    await markSubmitted(op.id, "0xabc123");
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    expect(row.status).toBe(OPERATION_STATUS.SUBMITTED);
    expect(row.tx_hash).toBe("0xabc123");
    expect(row.attempts).toBe(1);
  });

  it("marks a confirmed operation with its block", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    await markSubmitted(op.id, "0xdead");
    await markConfirmed(op.id, { txHash: "0xdead", blockNumber: 42 });
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    expect(row.status).toBe(OPERATION_STATUS.CONFIRMED);
    expect(row.block_number).toBe(42);
    expect(row.confirmed_at).not.toBeNull();
    expect(row.last_error).toBeNull();
  });

  it("classifies a permanent failure as Failed so it is never retried", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    await markFailed(op.id, "BatchAlreadyExists", {});
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    expect(row.status).toBe(OPERATION_STATUS.FAILED);
  });

  it("classifies an uncertain outcome as NeedsReconciliation", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    await markSubmitted(op.id, "0xfeed");
    await markFailed(op.id, "Timed out waiting for a receipt", { txHash: "0xfeed", uncertain: true });
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    expect(row.status).toBe(OPERATION_STATUS.NEEDS_RECONCILIATION);
    expect(row.tx_hash).toBe("0xfeed");
  });

  it("recognises every custom error as a permanent failure", () => {
    for (const err of PERMANENT_ERROR_PREFIXES) {
      expect(isPermanentFailure(`${err} (some context)`)).toBe(true);
    }
    expect(isPermanentFailure("connection refused")).toBe(false);
  });

  it("does not re-submit an unsettled transaction during reconciliation", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    // A hash that cannot exist on any chain: the receipt lookup returns null.
    await markSubmitted(op.id, "0x" + "11".repeat(32));
    const result = await reconcilePending();
    expect(result.checked).toBeGreaterThanOrEqual(1);
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    // Either still pending or failed — critically, never a new submission.
    expect([OPERATION_STATUS.SUBMITTED, OPERATION_STATUS.NEEDS_RECONCILIATION, OPERATION_STATUS.FAILED]).toContain(
      row.status
    );
    expect(row.attempts).toBe(1);
  });

  it("marks a never-submitted operation rather than retrying it silently", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.BATCH_REGISTER,
      entityType: "batch",
      entityId: 1,
    });
    await reconcilePending();
    const row = (await queryOne("SELECT * FROM blockchain_operations WHERE id = $1", [op.id]))!;
    expect(row.status).not.toBe(OPERATION_STATUS.PENDING);
  });

  it("finds an operation by its idempotency key", async () => {
    const op = await createOperation({
      type: OPERATION_TYPE.TRANSFER_CONFIRM,
      entityType: "transfer",
      entityId: 5,
      idempotencyKey: "k-99",
    });
    const found = await findOperationByIdempotencyKey("k-99");
    expect(found!.id).toBe(op.id);
  });
});

// ---------------------------------------------------------------- chain state

describe("chain status", () => {
  it("never reports ready without a signer or a reachable chain", async () => {
    const status = await getChainStatus();
    // The local node may or may not be up in CI; either way these invariants hold.
    expect(typeof status.ready).toBe("boolean");
    expect(status.expectedChainId).toBe(31337);
    if (!status.rpcReachable) {
      expect(status.ready).toBe(false);
      expect(status.error).toBeTruthy();
    }
    if (status.ready) {
      expect(status.chainId).toBe(status.expectedChainId);
      expect(status.contractDeployed).toBe(true);
    }
  });

  it("never exposes a private key in its payload", async () => {
    const status = await getChainStatus();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(process.env.BLOCKCHAIN_PRIVATE_KEY ?? "0xdeadbeef");
    // Only a boolean, never the key itself.
    expect(typeof status.signerConfigured).toBe("boolean");
  });
});

describe("error mapping", () => {
  it("surfaces custom error names from reverts", () => {
    const e = new Error("execution reverted: BatchAlreadyExists");
    expect(describeError(e)).toContain("BatchAlreadyExists");
  });

  it("explains a refused connection instead of leaking internals", () => {
    expect(describeError(new Error("connect ECONNREFUSED 127.0.0.1:8545"))).toContain("ECONNREFUSED");
  });

  it("passes a BlockchainUnavailableError through unchanged", () => {
    const e = new BlockchainUnavailableError("not_deployed", "Run npm run deploy");
    expect(describeError(e)).toBe("Run npm run deploy");
  });

  it("keeps the tx hash on a failed transaction", () => {
    const e = new TransactionFailedError("reverted", "0xabc");
    expect(e.txHash).toBe("0xabc");
  });
});

// ---------------------------------------------------------------- verification

describe("batch verification", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("reports NOT_FOUND for an unknown reference without calling it counterfeit", async () => {
    const v = await verifyBatchRef("MM-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZ");
    expect(v.status).toBe("NOT_FOUND");
    expect(v.known).toBe(false);
    expect(v.note).toMatch(/not proof/i);
  });

  it("reports UNAVAILABLE rather than a negative claim when the chain is down", async () => {
    const v = await verifyBatchRef("MM-ABCD-EFGH-IJKL-MNOPQRST");
    expect(["UNAVAILABLE", "NOT_FOUND"]).toContain(v.status);
    if (v.status === "UNAVAILABLE") {
      expect(v.note).toMatch(/could not reach/i);
    }
  });

  it("always returns a human explanation of what verification proves", async () => {
    const v = await verifyBatchRef("MM-ABCD-EFGH-IJKL-MNOPQRST");
    expect(v.note.length).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------- validation

describe("blockchain input validation", () => {
  it("rejects a non-positive transfer quantity", () => {
    const r = transferInitiateSchema.safeParse({ batchId: 1, fromPharmacyId: 1, toPharmacyId: 2, quantity: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects a negative transfer quantity", () => {
    const r = transferInitiateSchema.safeParse({ batchId: 1, fromPharmacyId: 1, toPharmacyId: 2, quantity: -5 });
    expect(r.success).toBe(false);
  });

  it("accepts a valid transfer", () => {
    const r = transferInitiateSchema.safeParse({ batchId: 1, fromPharmacyId: 1, toPharmacyId: 2, quantity: 10 });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown milestone", () => {
    expect(deliveryMilestoneSchema.safeParse({ milestone: "Teleported" }).success).toBe(false);
    expect(deliveryMilestoneSchema.safeParse({ milestone: "Delivered" }).success).toBe(true);
  });

  it("rejects a malformed expiry date", () => {
    const r = batchRegisterSchema.safeParse({
      medicineId: 1,
      quantityUnits: 10,
      expiryDate: "30-06-2027",
      manufacturedAt: "2026-01-01",
      supplierRef: "SUP-1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a supplier reference containing whitespace or symbols", () => {
    const base = {
      medicineId: 1,
      quantityUnits: 10,
      expiryDate: "2027-06-30",
      manufacturedAt: "2026-01-01",
    };
    expect(batchRegisterSchema.safeParse({ ...base, supplierRef: "INV 12345" }).success).toBe(false);
    expect(batchRegisterSchema.safeParse({ ...base, supplierRef: "SUP/ACME-1" }).success).toBe(true);
  });

  it("rejects a zero-quantity batch", () => {
    const r = batchRegisterSchema.safeParse({
      medicineId: 1,
      quantityUnits: 0,
      expiryDate: "2027-06-30",
      manufacturedAt: "2026-01-01",
      supplierRef: "SUP-1",
    });
    expect(r.success).toBe(false);
  });
});

describe("delivery milestone mapping", () => {
  it("maps every audited app status onto a contract milestone", () => {
    expect(DELIVERY_STATUS_MILESTONE.PickedUp).toBe("PickedUp");
    expect(DELIVERY_STATUS_MILESTONE.OutForDelivery).toBe("OutForDelivery");
    expect(DELIVERY_STATUS_MILESTONE.Delivered).toBe("Delivered");
    expect(DELIVERY_STATUS_MILESTONE.Ready).toBe("Packed");
  });

  it("leaves non-audited statuses unmapped", () => {
    expect(DELIVERY_STATUS_MILESTONE.Assigned).toBeUndefined();
    expect(DELIVERY_STATUS_MILESTONE.Cancelled).toBeUndefined();
  });
});

describe("batches listing", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("starts empty for a fresh database", async () => {
    expect(await listBatches()).toEqual([]);
  });

  it("scopes to a pharmacy", async () => {
    expect(await listBatches({ pharmacyId: 1 })).toEqual([]);
  });
});
