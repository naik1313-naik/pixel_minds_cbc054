import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

// Milestone enum order must mirror the contract.
const M = { None: 0, Packed: 1, PickedUp: 2, OutForDelivery: 3, Delivered: 4 } as const;
const BS = { None: 0, Registered: 1, Revoked: 2 } as const;
const TS = { None: 0, Initiated: 1, Confirmed: 2, Rejected: 3, Cancelled: 4 } as const;

const id = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const BATCH = id("MM-BATCH-0001");
const META = id("metadata-v1");
const ZERO = "0x" + "0".repeat(64);

describe("MediMeshLedger", () => {
  let admin: HardhatEthersSigner;
  let pharmacyA: HardhatEthersSigner;
  let pharmacyB: HardhatEthersSigner;
  let pharmacyC: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let rider: HardhatEthersSigner;
  let ledger: any;

  const transferId = (s: string) => id(`transfer-${s}`);
  const orderRef = (s: string) => id(`order-${s}`);

  beforeEach(async () => {
    [admin, pharmacyA, pharmacyB, pharmacyC, stranger, rider] = await ethers.getSigners();
    const F = await ethers.getContractFactory("MediMeshLedger");
    ledger = await F.deploy(admin.address);
    await ledger.waitForDeployment();
    await ledger.authorizePharmacy(pharmacyA.address);
    await ledger.authorizePharmacy(pharmacyB.address);
    await ledger.authorizePharmacy(pharmacyC.address);
    await ledger.authorizeDeliveryActor(rider.address);
  });

  // ------------------------------------------------------------------ deploy

  describe("deployment", () => {
    it("assigns DEFAULT_ADMIN_ROLE to the deployer", async () => {
      expect(await ledger.hasRole(await ledger.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("makes the admin the role admin for PHARMACY_ROLE and DELIVERY_ROLE", async () => {
      expect(await ledger.getRoleAdmin(await ledger.PHARMACY_ROLE())).to.equal(
        await ledger.DEFAULT_ADMIN_ROLE()
      );
      expect(await ledger.getRoleAdmin(await ledger.DELIVERY_ROLE())).to.equal(
        await ledger.DEFAULT_ADMIN_ROLE()
      );
    });

    it("rejects deployment with a zero admin", async () => {
      const F = await ethers.getContractFactory("MediMeshLedger");
      // ethers.ZeroAddress (not a "0x00.." literal) so it is not ENS-resolved.
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
    });
  });

  // ------------------------------------------------------------------ roles

  describe("access control", () => {
    it("lets only the admin authorize a pharmacy", async () => {
      await expect(
        ledger.connect(pharmacyA).authorizePharmacy(stranger.address)
      ).to.be.revertedWithCustomError(ledger, "NotAdmin");

      await expect(ledger.connect(admin).authorizePharmacy(stranger.address))
        .to.emit(ledger, "PharmacyAuthorized")
        .withArgs(stranger.address, admin.address);
      expect(await ledger.hasRole(await ledger.PHARMACY_ROLE(), stranger.address)).to.equal(true);
    });

    it("lets only the admin revoke a pharmacy", async () => {
      await expect(ledger.connect(pharmacyA).revokePharmacy(pharmacyB.address)).to.be.revertedWithCustomError(
        ledger,
        "NotAdmin"
      );
      await expect(ledger.connect(admin).revokePharmacy(pharmacyB.address))
        .to.emit(ledger, "PharmacyRevoked");
      expect(await ledger.hasRole(await ledger.PHARMACY_ROLE(), pharmacyB.address)).to.equal(false);
    });

    it("prevents a revoked pharmacy from registering batches", async () => {
      await ledger.connect(admin).revokePharmacy(pharmacyA.address);
      await expect(ledger.connect(pharmacyA).registerBatch(BATCH, META)).to.be.revertedWithCustomError(
        ledger,
        "NotPharmacy"
      );
    });

    it("emits auditable events on delivery actor changes", async () => {
      await expect(ledger.connect(admin).authorizeDeliveryActor(stranger.address))
        .to.emit(ledger, "DeliveryAuthorized")
        .withArgs(stranger.address, admin.address);
      await expect(ledger.connect(admin).revokeDeliveryActor(stranger.address))
        .to.emit(ledger, "DeliveryRevoked")
        .withArgs(stranger.address, admin.address);
    });
  });

  // ------------------------------------------------------------------ batches

  describe("batch registry", () => {
    it("registers a batch and stores the metadata hash", async () => {
      await expect(ledger.connect(pharmacyA).registerBatch(BATCH, META))
        .to.emit(ledger, "BatchRegistered")
        .withArgs(BATCH, META, pharmacyA.address, anyValue);

      const b = await ledger.getBatch(BATCH);
      expect(b.id).to.equal(BATCH);
      expect(b.metadataHash).to.equal(META);
      expect(b.registeredBy).to.equal(pharmacyA.address);
      expect(Number(b.status)).to.equal(BS.Registered);
      expect(Number(b.registeredAt)).to.be.greaterThan(0);
    });

    it("rejects registration by an unauthorized address", async () => {
      await expect(ledger.connect(stranger).registerBatch(BATCH, META)).to.be.revertedWithCustomError(
        ledger,
        "NotPharmacy"
      );
      expect((await ledger.getBatch(BATCH)).status).to.equal(BS.None);
    });

    it("rejects a duplicate batch registration", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await expect(ledger.connect(pharmacyB).registerBatch(BATCH, META)).to.be.revertedWithCustomError(
        ledger,
        "BatchAlreadyExists"
      );
    });

    it("rejects an empty batch id and empty metadata hash", async () => {
      await expect(ledger.connect(pharmacyA).registerBatch(ZERO, META)).to.be.revertedWithCustomError(
        ledger,
        "EmptyBatchId"
      );
      await expect(ledger.connect(pharmacyA).registerBatch(BATCH, ZERO)).to.be.revertedWithCustomError(
        ledger,
        "EmptyMetadataHash"
      );
    });

    it("verifies a registered batch", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      const [registered, active] = await ledger.verifyBatch(BATCH);
      expect(registered).to.equal(true);
      expect(active).to.equal(true);
    });

    it("reports an unknown batch as not registered", async () => {
      const [registered, active] = await ledger.verifyBatch(id("nope"));
      expect(registered).to.equal(false);
      expect(active).to.equal(false);
      expect(await ledger.batchExists(id("nope"))).to.equal(false);
    });

    it("revokes a batch and stops reporting it active", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await expect(ledger.connect(pharmacyA).revokeBatch(BATCH))
        .to.emit(ledger, "BatchRevoked")
        .withArgs(BATCH, pharmacyA.address, anyValue);

      const [registered, active] = await ledger.verifyBatch(BATCH);
      expect(registered).to.equal(true);
      expect(active).to.equal(false);
      expect(Number((await ledger.getBatch(BATCH)).status)).to.equal(BS.Revoked);
    });

    it("rejects revocation by an unauthorized address", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await expect(ledger.connect(stranger).revokeBatch(BATCH)).to.be.revertedWithCustomError(
        ledger,
        "NotPharmacy"
      );
    });

    it("rejects revoking an unknown batch and double revocation", async () => {
      await expect(ledger.connect(pharmacyA).revokeBatch(BATCH)).to.be.revertedWithCustomError(
        ledger,
        "BatchNotFound"
      );
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await ledger.connect(pharmacyA).revokeBatch(BATCH);
      await expect(ledger.connect(pharmacyA).revokeBatch(BATCH)).to.be.revertedWithCustomError(
        ledger,
        "BatchAlreadyRevoked"
      );
    });

    it("preserves the original registrant and hash through revocation", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await ledger.connect(pharmacyB).revokeBatch(BATCH);
      const b = await ledger.getBatch(BATCH);
      expect(b.metadataHash).to.equal(META);
      expect(b.registeredBy).to.equal(pharmacyA.address);
    });

    it("lets the admin reinstate a revoked batch", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await ledger.connect(pharmacyA).revokeBatch(BATCH);
      await expect(ledger.connect(admin).reinstateBatch(BATCH)).to.emit(ledger, "BatchReinstated");
      expect((await ledger.verifyBatch(BATCH))[1]).to.equal(true);
    });

    it("does not let a non-admin reinstate", async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
      await ledger.connect(pharmacyA).revokeBatch(BATCH);
      await expect(ledger.connect(pharmacyA).reinstateBatch(BATCH)).to.be.revertedWithCustomError(
        ledger,
        "NotAdmin"
      );
    });
  });

  // ------------------------------------------------------------------ transfers

  describe("transfer lifecycle", () => {
    beforeEach(async () => {
      await ledger.connect(pharmacyA).registerBatch(BATCH, META);
    });

    it("initiates a transfer and stores full state", async () => {
      const t = transferId("t1");
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 10)
      )
        .to.emit(ledger, "TransferInitiated")
        .withArgs(t, BATCH, pharmacyA.address, pharmacyB.address, 10, anyValue);

      const s = await ledger.getTransfer(t);
      expect(s.id).to.equal(t);
      expect(s.batchId).to.equal(BATCH);
      expect(s.from).to.equal(pharmacyA.address);
      expect(s.to).to.equal(pharmacyB.address);
      expect(s.quantity).to.equal(10n);
      expect(Number(s.status)).to.equal(TS.Initiated);
      expect(Number(s.settledAt)).to.equal(0);
    });

    it("rejects a zero quantity", async () => {
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(transferId("t0"), BATCH, pharmacyB.address, 0)
      ).to.be.revertedWithCustomError(ledger, "ZeroQuantity");
    });

    it("rejects a transfer to the same pharmacy", async () => {
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(transferId("same"), BATCH, pharmacyA.address, 5)
      ).to.be.revertedWithCustomError(ledger, "SamePharmacy");
    });

    it("rejects a destination that is not an authorized pharmacy", async () => {
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(transferId("str"), BATCH, stranger.address, 5)
      ).to.be.revertedWithCustomError(ledger, "NotPharmacy");
    });

    it("rejects initiation by an unauthorized address", async () => {
      await expect(
        ledger.connect(stranger).initiateTransfer(transferId("unauth"), BATCH, pharmacyB.address, 5)
      ).to.be.revertedWithCustomError(ledger, "NotPharmacy");
    });

    it("rejects a duplicate transfer id", async () => {
      const t = transferId("dup");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);
      await expect(
        ledger.connect(pharmacyB).initiateTransfer(t, BATCH, pharmacyC.address, 5)
      ).to.be.revertedWithCustomError(ledger, "TransferAlreadyExists");
    });

    it("rejects a transfer for an unknown batch", async () => {
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(transferId("nobatch"), id("missing"), pharmacyB.address, 5)
      ).to.be.revertedWithCustomError(ledger, "BatchNotFound");
    });

    it("rejects a transfer for a revoked batch", async () => {
      await ledger.connect(pharmacyA).revokeBatch(BATCH);
      await expect(
        ledger.connect(pharmacyA).initiateTransfer(transferId("rev"), BATCH, pharmacyB.address, 5)
      ).to.be.revertedWithCustomError(ledger, "BatchNotActive");
    });

    it("allows only the destination to confirm", async () => {
      const t = transferId("conf");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);

      // Source cannot confirm its own receipt.
      await expect(ledger.connect(pharmacyA).confirmTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "NotDestinationPharmacy"
      );
      // A third pharmacy cannot confirm.
      await expect(ledger.connect(pharmacyC).confirmTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "NotDestinationPharmacy"
      );
      await expect(ledger.connect(pharmacyB).confirmTransfer(t))
        .to.emit(ledger, "TransferConfirmed")
        .withArgs(t, pharmacyB.address, anyValue);

      const s = await ledger.getTransfer(t);
      expect(Number(s.status)).to.equal(TS.Confirmed);
      expect(Number(s.settledAt)).to.be.greaterThan(0);
    });

    it("rejects confirming an unknown transfer", async () => {
      await expect(
        ledger.connect(pharmacyB).confirmTransfer(transferId("ghost"))
      ).to.be.revertedWithCustomError(ledger, "TransferNotFound");
    });

    it("rejects a second confirmation", async () => {
      const t = transferId("dbl");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);
      await ledger.connect(pharmacyB).confirmTransfer(t);
      await expect(ledger.connect(pharmacyB).confirmTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "TransferAlreadySettled"
      );
    });

    it("rejects an unauthorized cancellation", async () => {
      const t = transferId("cancel");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);
      await expect(ledger.connect(pharmacyC).cancelTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "NotSourcePharmacy"
      );
      await expect(ledger.connect(pharmacyA).cancelTransfer(t)).to.emit(ledger, "TransferCancelled");
      expect(Number((await ledger.getTransfer(t)).status)).to.equal(TS.Cancelled);
    });

    it("rejects confirmation after cancellation", async () => {
      const t = transferId("cancelconf");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);
      await ledger.connect(pharmacyA).cancelTransfer(t);
      await expect(ledger.connect(pharmacyB).confirmTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "TransferAlreadySettled"
      );
    });

    it("lets only the destination reject, then blocks confirmation", async () => {
      const t = transferId("rej");
      await ledger.connect(pharmacyA).initiateTransfer(t, BATCH, pharmacyB.address, 5);
      await expect(ledger.connect(pharmacyA).rejectTransfer(t, ZERO)).to.be.revertedWithCustomError(
        ledger,
        "NotDestinationPharmacy"
      );
      await expect(ledger.connect(pharmacyB).rejectTransfer(t, id("out-of-stock")))
        .to.emit(ledger, "TransferRejected")
        .withArgs(t, pharmacyB.address, id("out-of-stock"));
      await expect(ledger.connect(pharmacyB).confirmTransfer(t)).to.be.revertedWithCustomError(
        ledger,
        "TransferAlreadySettled"
      );
    });
  });

  // ------------------------------------------------------------------ deliveries

  describe("delivery audit trail", () => {
    it("records the full milestone progression in order", async () => {
      const o = orderRef("d1");
      await expect(ledger.connect(pharmacyA).recordDeliveryEvent(o, M.Packed))
        .to.emit(ledger, "DeliveryMilestoneRecorded")
        .withArgs(o, M.Packed, pharmacyA.address, anyValue, 1n);

      await ledger.connect(rider).recordDeliveryEvent(o, M.PickedUp);
      await ledger.connect(rider).recordDeliveryEvent(o, M.OutForDelivery);
      await ledger.connect(rider).recordDeliveryEvent(o, M.Delivered);

      const s = await ledger.getDeliveryState(o);
      expect(Number(s.lastMilestone)).to.equal(M.Delivered);
      expect(s.milestoneCount).to.equal(4n);
      expect(await ledger.isDelivered(o)).to.equal(true);
      expect(await ledger.hasMilestone(o, M.OutForDelivery)).to.equal(true);
    });

    it("rejects starting from a milestone other than Packed", async () => {
      await expect(
        ledger.connect(rider).recordDeliveryEvent(orderRef("d2"), M.OutForDelivery)
      ).to.be.revertedWithCustomError(ledger, "MilestoneOutOfOrder");
    });

    it("rejects skipping a milestone", async () => {
      const o = orderRef("d3");
      await ledger.connect(rider).recordDeliveryEvent(o, M.Packed);
      await expect(ledger.connect(rider).recordDeliveryEvent(o, M.Delivered)).to.be.revertedWithCustomError(
        ledger,
        "MilestoneOutOfOrder"
      );
    });

    it("rejects replaying the same milestone", async () => {
      const o = orderRef("d4");
      await ledger.connect(rider).recordDeliveryEvent(o, M.Packed);
      await expect(ledger.connect(rider).recordDeliveryEvent(o, M.Packed)).to.be.revertedWithCustomError(
        ledger,
        "MilestoneOutOfOrder"
      );
    });

    it("rejects regressing after Delivered", async () => {
      const o = orderRef("d5");
      await ledger.connect(rider).recordDeliveryEvent(o, M.Packed);
      await ledger.connect(rider).recordDeliveryEvent(o, M.PickedUp);
      await ledger.connect(rider).recordDeliveryEvent(o, M.OutForDelivery);
      await ledger.connect(rider).recordDeliveryEvent(o, M.Delivered);
      await expect(ledger.connect(rider).recordDeliveryEvent(o, M.Packed)).to.be.revertedWithCustomError(
        ledger,
        "MilestoneOutOfOrder"
      );
    });

    it("rejects an unauthorized actor", async () => {
      await expect(
        ledger.connect(stranger).recordDeliveryEvent(orderRef("d6"), M.Packed)
      ).to.be.revertedWithCustomError(ledger, "NotDeliveryActor");
    });

    it("rejects a zero order reference", async () => {
      await expect(
        ledger.connect(rider).recordDeliveryEvent(ZERO, M.Packed)
      ).to.be.revertedWithCustomError(ledger, "BatchNotFound");
    });

    it("rejects out-of-range milestone values", async () => {
      const o = orderRef("d7");
      await expect(ledger.connect(rider).recordDeliveryEvent(o, 0)).to.be.revertedWithCustomError(
        ledger,
        "InvalidMilestone"
      );
      await expect(ledger.connect(rider).recordDeliveryEvent(o, 5)).to.be.revertedWithCustomError(
        ledger,
        "InvalidMilestone"
      );
    });

    it("keeps distinct order references independent", async () => {
      const a = orderRef("d8a");
      const b = orderRef("d8b");
      // Drive order b all the way to Delivered while order a stays at Packed.
      await ledger.connect(rider).recordDeliveryEvent(a, M.Packed);
      await ledger.connect(rider).recordDeliveryEvent(b, M.Packed);
      await ledger.connect(rider).recordDeliveryEvent(b, M.PickedUp);
      await ledger.connect(rider).recordDeliveryEvent(b, M.OutForDelivery);
      await ledger.connect(rider).recordDeliveryEvent(b, M.Delivered);

      expect(Number((await ledger.getDeliveryState(a)).lastMilestone)).to.equal(M.Packed);
      expect((await ledger.getDeliveryState(a)).milestoneCount).to.equal(1n);
      expect(Number((await ledger.getDeliveryState(b)).lastMilestone)).to.equal(M.Delivered);
      expect(await ledger.isDelivered(a)).to.equal(false);
      expect(await ledger.isDelivered(b)).to.equal(true);
    });

    it("allows a pharmacy wallet to record the packing milestone", async () => {
      const o = orderRef("d9");
      await expect(ledger.connect(pharmacyA).recordDeliveryEvent(o, M.Packed)).to.emit(
        ledger,
        "DeliveryMilestoneRecorded"
      );
    });
  });

  // -------------------------------------------------------------- settlements

  describe("settlement audit", () => {
    const settlementId = (s: string) => id(`settlement-${s}`);
    const SETTLEMENT_HASH = id("settlement-metadata-v1");

    it("records a settlement and reads it back", async () => {
      const s = settlementId("s1");
      const o = orderRef("paid-1");
      await expect(
        ledger.connect(pharmacyA).recordSettlement(s, o, SETTLEMENT_HASH, 9500, pharmacyA.address)
      )
        .to.emit(ledger, "SettlementRecorded")
        .withArgs(s, o, pharmacyA.address, 9500, SETTLEMENT_HASH, anyValue);

      const stored = await ledger.getSettlement(s);
      expect(stored.id).to.equal(s);
      expect(stored.orderRef).to.equal(o);
      expect(stored.beneficiary).to.equal(pharmacyA.address);
      expect(stored.amountPaise).to.equal(9500n);
      expect(stored.settlementHash).to.equal(SETTLEMENT_HASH);
      expect(stored.settledAt).to.be.greaterThan(0n);
      expect(await ledger.settlementExists(s)).to.equal(true);
    });

    it("records who reported the settlement", async () => {
      const s = settlementId("s-reporter");
      await ledger.connect(rider).recordSettlement(s, orderRef("paid-r"), SETTLEMENT_HASH, 100, pharmacyA.address);
      const stored = await ledger.getSettlement(s);
      expect(stored.reportedBy).to.equal(rider.address);
      // The beneficiary is still the pharmacy, not the reporter.
      expect(stored.beneficiary).to.equal(pharmacyA.address);
    });

    it("rejects a replayed settlement reference", async () => {
      const s = settlementId("s-replay");
      await ledger.connect(pharmacyA).recordSettlement(s, orderRef("a"), SETTLEMENT_HASH, 100, pharmacyA.address);
      await expect(
        ledger.connect(pharmacyA).recordSettlement(s, orderRef("b"), SETTLEMENT_HASH, 999, pharmacyA.address)
      ).to.be.revertedWithCustomError(ledger, "SettlementAlreadyRecorded");
    });

    it("refuses a beneficiary that is not an authorized pharmacy", async () => {
      await expect(
        ledger
          .connect(pharmacyA)
          .recordSettlement(settlementId("s-bad"), orderRef("c"), SETTLEMENT_HASH, 100, stranger.address)
      )
        .to.be.revertedWithCustomError(ledger, "NotPharmacy")
        .withArgs(stranger.address);
    });

    it("refuses an unauthorized reporter", async () => {
      await expect(
        ledger.connect(stranger).recordSettlement(settlementId("s-str"), orderRef("d"), SETTLEMENT_HASH, 100, pharmacyA.address)
      )
        .to.be.revertedWithCustomError(ledger, "NotDeliveryActor")
        .withArgs(stranger.address);
    });

    it("anchors a rider fee separately from the pharmacy settlement", async () => {
      const riderId = settlementId("s-rider");
      const o = orderRef("delivered-1");
      await expect(
        ledger.connect(rider).recordRiderSettlement(riderId, o, SETTLEMENT_HASH, 2500, rider.address)
      )
        .to.emit(ledger, "RiderSettlementRecorded")
        .withArgs(riderId, o, rider.address, 2500, SETTLEMENT_HASH, anyValue);

      const stored = await ledger.getSettlement(riderId);
      expect(stored.beneficiary).to.equal(rider.address);
      expect(stored.amountPaise).to.equal(2500n);

      // The pharmacy's anchor is a different key, so neither invalidates the
      // other: a dispute about one amount leaves the other still provable.
      const pharmacyId = settlementId("s-pharmacy");
      await ledger.connect(rider).recordSettlement(pharmacyId, o, SETTLEMENT_HASH, 9500, pharmacyA.address);
      expect((await ledger.getSettlement(riderId)).amountPaise).to.equal(2500n);
      expect((await ledger.getSettlement(pharmacyId)).amountPaise).to.equal(9500n);
    });

    it("refuses to pay a rider fee to a pharmacy that is not a rider", async () => {
      await expect(
        ledger
          .connect(rider)
          .recordRiderSettlement(settlementId("s-r-bad"), orderRef("i"), SETTLEMENT_HASH, 2500, pharmacyA.address)
      )
        .to.be.revertedWithCustomError(ledger, "NotDeliveryActor")
        .withArgs(pharmacyA.address);
    });

    it("refuses to pay a rider fee to an unauthorized wallet", async () => {
      await expect(
        ledger
          .connect(rider)
          .recordRiderSettlement(settlementId("s-r-str"), orderRef("j"), SETTLEMENT_HASH, 2500, stranger.address)
      )
        .to.be.revertedWithCustomError(ledger, "NotDeliveryActor");
    });

    it("rejects a replayed rider fee reference", async () => {
      const s = settlementId("s-r-replay");
      await ledger.connect(rider).recordRiderSettlement(s, orderRef("k"), SETTLEMENT_HASH, 2500, rider.address);
      await expect(
        ledger.connect(rider).recordRiderSettlement(s, orderRef("l"), SETTLEMENT_HASH, 999, rider.address)
      ).to.be.revertedWithCustomError(ledger, "SettlementAlreadyRecorded");
    });

    it("rejects zero amounts and empty references", async () => {
      await expect(
        ledger.connect(pharmacyA).recordSettlement(settlementId("s-zero"), orderRef("e"), SETTLEMENT_HASH, 0, pharmacyA.address)
      ).to.be.revertedWithCustomError(ledger, "ZeroAmount");

      await expect(
        ledger.connect(pharmacyA).recordSettlement(ZERO, orderRef("f"), SETTLEMENT_HASH, 100, pharmacyA.address)
      ).to.be.revertedWithCustomError(ledger, "EmptySettlementId");

      await expect(
        ledger.connect(pharmacyA).recordSettlement(settlementId("s-o"), ZERO, SETTLEMENT_HASH, 100, pharmacyA.address)
      ).to.be.revertedWithCustomError(ledger, "EmptyOrderRef");

      await expect(
        ledger.connect(pharmacyA).recordSettlement(settlementId("s-h"), orderRef("g"), ZERO, 100, pharmacyA.address)
      ).to.be.revertedWithCustomError(ledger, "EmptySettlementHash");

      await expect(
        ledger.connect(pharmacyA).recordSettlement(settlementId("s-z"), orderRef("h"), SETTLEMENT_HASH, 100, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ledger, "ZeroAddress");
    });

    it("reports an unknown settlement as absent", async () => {
      const s = settlementId("never-recorded");
      expect(await ledger.settlementExists(s)).to.equal(false);
      const stored = await ledger.getSettlement(s);
      expect(stored.settledAt).to.equal(0n);
    });
  });
});
