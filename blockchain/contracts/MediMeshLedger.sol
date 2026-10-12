// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MediMeshLedger
 * @notice Verifiable audit layer for MediMesh medicine batches, inter-pharmacy
 *         transfers and delivery milestones.
 *
 * @dev Design constraints (see docs/blockchain.md):
 *
 *      - Only opaque references and hashes live on-chain. No customer names,
 *        addresses, phone numbers, prescriptions, payment data or GPS traces
 *        are ever stored here.
 *      - This contract records *that an authorized actor reported an event*.
 *        It does not and cannot attest to the physical authenticity of a
 *        medicine, nor that goods physically moved. Callers must present
 *        registration as "recorded and auditable", never as "genuine".
 *      - SQLite remains the operational source of truth for stock. This
 *        contract never reads or mutates application inventory.
 *
 *      Roles:
 *        DEFAULT_ADMIN_ROLE   - authorizes/revokes pharmacy and delivery wallets
 *        PHARMACY_ROLE        - registers batches, initiates/cancels transfers
 *        DELIVERY_ROLE        - records delivery milestones
 *
 *      A pharmacy wallet may hold PHARMACY_ROLE only; confirmation of an
 *      inbound transfer additionally requires the transfer to name that
 *      address as destination, which is enforced per-transfer rather than by a
 *      separate role.
 */
contract MediMeshLedger is AccessControl, ReentrancyGuard {
    // ---------------------------------------------------------------- roles

    bytes32 public constant PHARMACY_ROLE = keccak256("PHARMACY_ROLE");
    bytes32 public constant DELIVERY_ROLE = keccak256("DELIVERY_ROLE");

    // ---------------------------------------------------------------- types

    /// @notice Lifecycle of a medicine batch. Registered != genuine.
    enum BatchStatus {
        None,
        Registered,
        Revoked
    }

    /// @notice Lifecycle of an inter-pharmacy transfer.
    enum TransferStatus {
        None,
        Initiated,
        Confirmed,
        Rejected,
        Cancelled
    }

    /// @notice Delivery milestones. Mirrors the application's delivery lifecycle.
    enum Milestone {
        None,
        Packed,
        PickedUp,
        OutForDelivery,
        Delivered
    }

    struct Batch {
        bytes32 id; // keccak256 of the opaque batch reference
        bytes32 metadataHash; // keccak256 of canonical off-chain metadata
        address registeredBy; // pharmacy wallet
        uint64 registeredAt; // block timestamp
        BatchStatus status;
    }

    struct Transfer {
        bytes32 id;
        bytes32 batchId;
        address from;
        address to;
        uint256 quantity;
        TransferStatus status;
        uint64 createdAt;
        uint64 settledAt; // confirmation/rejection/cancellation time
    }

    struct DeliveryState {
        Milestone lastMilestone;
        uint64 updatedAt;
        uint256 milestoneCount;
    }

    // ---------------------------------------------------------------- storage

    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => Transfer) private _transfers;
    mapping(bytes32 => DeliveryState) private _deliveries;

    // Guards replay: a given (delivery, milestone) pair may only be recorded once.
    mapping(bytes32 => mapping(Milestone => bool)) private _milestoneRecorded;

    // ---------------------------------------------------------------- events

    event PharmacyAuthorized(address indexed pharmacy, address indexed by);
    event PharmacyRevoked(address indexed pharmacy, address indexed by);
    event DeliveryAuthorized(address indexed actor, address indexed by);
    event DeliveryRevoked(address indexed actor, address indexed by);
    // RoleAdminChanged is inherited from OpenZeppelin IAccessControl and is
    // emitted automatically by _setRoleAdmin.

    event BatchRegistered(
        bytes32 indexed batchId,
        bytes32 indexed metadataHash,
        address indexed registeredBy,
        uint64 registeredAt
    );
    event BatchRevoked(bytes32 indexed batchId, address indexed revokedBy, uint64 revokedAt);
    event BatchReinstated(bytes32 indexed batchId, address indexed by, uint64 reinstatedAt);

    event TransferInitiated(
        bytes32 indexed transferId,
        bytes32 indexed batchId,
        address indexed from,
        address to,
        uint256 quantity,
        uint64 createdAt
    );
    event TransferConfirmed(bytes32 indexed transferId, address indexed confirmedBy, uint64 confirmedAt);
    event TransferRejected(bytes32 indexed transferId, address indexed rejectedBy, bytes32 reasonHash);
    event TransferCancelled(bytes32 indexed transferId, address indexed cancelledBy);

    event DeliveryMilestoneRecorded(
        bytes32 indexed orderRef,
        Milestone milestone,
        address indexed actor,
        uint64 blockTimestamp,
        uint256 milestoneIndex
    );

    // ---------------------------------------------------------------- errors

    error NotAdmin(address caller);
    error NotPharmacy(address caller);
    error NotDeliveryActor(address caller);
    error EmptyBatchId();
    error EmptyMetadataHash();
    error BatchAlreadyExists(bytes32 batchId);
    error BatchNotFound(bytes32 batchId);
    error BatchNotActive(bytes32 batchId);
    error BatchAlreadyRevoked(bytes32 batchId);
    error SamePharmacy(address pharmacy);
    error ZeroQuantity();
    error TransferAlreadyExists(bytes32 transferId);
    error TransferNotFound(bytes32 transferId);
    error TransferNotInitiated(bytes32 transferId);
    error TransferAlreadySettled(bytes32 transferId);
    error NotSourcePharmacy(address caller, address expected);
    error NotDestinationPharmacy(address caller, address expected);
    error InvalidMilestone(uint8 milestone);
    error MilestoneOutOfOrder(uint8 from, uint8 to);
    error MilestoneAlreadyRecorded(uint8 milestone);
    error DeliveryAlreadyDelivered();
    error ZeroAddress();

    // ---------------------------------------------------------------- modifiers

    modifier onlyAdmin() {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyPharmacy() {
        if (!hasRole(PHARMACY_ROLE, msg.sender)) revert NotPharmacy(msg.sender);
        _;
    }

    modifier onlyDeliveryActor() {
        // A pharmacy wallet is also permitted to record packing milestones;
        // both roles are audited independently.
        if (!hasRole(DELIVERY_ROLE, msg.sender) && !hasRole(PHARMACY_ROLE, msg.sender)) {
            revert NotDeliveryActor(msg.sender);
        }
        _;
    }

    // ---------------------------------------------------------------- admin

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        // Admin manages the domain roles by default.
        // _setRoleAdmin emits the inherited RoleAdminChanged event.
        _setRoleAdmin(PHARMACY_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(DELIVERY_ROLE, DEFAULT_ADMIN_ROLE);
    }

    /// @notice Authorize a pharmacy wallet. Emits an auditable event.
    function authorizePharmacy(address pharmacy) external onlyAdmin {
        if (pharmacy == address(0)) revert ZeroAddress();
        if (hasRole(PHARMACY_ROLE, pharmacy)) return;
        _grantRole(PHARMACY_ROLE, pharmacy);
        emit PharmacyAuthorized(pharmacy, msg.sender);
    }

    /// @notice Revoke a pharmacy wallet. Existing batches are not deleted —
    ///         revocation stops *future* writes and is itself an event.
    function revokePharmacy(address pharmacy) external onlyAdmin {
        _revokeRole(PHARMACY_ROLE, pharmacy);
        emit PharmacyRevoked(pharmacy, msg.sender);
    }

    function authorizeDeliveryActor(address actor) external onlyAdmin {
        if (actor == address(0)) revert ZeroAddress();
        if (hasRole(DELIVERY_ROLE, actor)) return;
        _grantRole(DELIVERY_ROLE, actor);
        emit DeliveryAuthorized(actor, msg.sender);
    }

    function revokeDeliveryActor(address actor) external onlyAdmin {
        _revokeRole(DELIVERY_ROLE, actor);
        emit DeliveryRevoked(actor, msg.sender);
    }

    // ---------------------------------------------------------------- batches

    /**
     * @notice Register a medicine batch.
     * @param batchId keccak256 of the opaque batch reference.
     * @param metadataHash keccak256 of canonical off-chain metadata (see hashes.ts).
     * @dev Duplicate registration is rejected outright — the registry is
     *      append-only. Corrections are made by revoking, never overwriting.
     */
    function registerBatch(bytes32 batchId, bytes32 metadataHash) external onlyPharmacy nonReentrant {
        if (batchId == bytes32(0)) revert EmptyBatchId();
        if (metadataHash == bytes32(0)) revert EmptyMetadataHash();
        if (_batches[batchId].status != BatchStatus.None) revert BatchAlreadyExists(batchId);

        _batches[batchId] = Batch({
            id: batchId,
            metadataHash: metadataHash,
            registeredBy: msg.sender,
            registeredAt: uint64(block.timestamp),
            status: BatchStatus.Registered
        });

        emit BatchRegistered(batchId, metadataHash, msg.sender, uint64(block.timestamp));
    }

    /// @notice Revoke a batch. Any pharmacy may report a revocation; the
    ///         original registrant or an admin may also do so.
    function revokeBatch(bytes32 batchId) external onlyPharmacy {
        Batch storage batch = _batches[batchId];
        if (batch.status == BatchStatus.None) revert BatchNotFound(batchId);
        if (batch.status == BatchStatus.Revoked) revert BatchAlreadyRevoked(batchId);

        batch.status = BatchStatus.Revoked;
        emit BatchRevoked(batchId, msg.sender, uint64(block.timestamp));
    }

    /// @notice Reinstate a previously revoked batch. Reserved for admin use
    ///         after a false-positive revocation; still an explicit event.
    function reinstateBatch(bytes32 batchId) external onlyAdmin {
        Batch storage batch = _batches[batchId];
        if (batch.status == BatchStatus.None) revert BatchNotFound(batchId);
        if (batch.status == BatchStatus.Registered) revert BatchAlreadyExists(batchId);

        batch.status = BatchStatus.Registered;
        emit BatchReinstated(batchId, msg.sender, uint64(block.timestamp));
    }

    /// @notice Read a batch. Returns zeroed fields when unknown.
    function getBatch(bytes32 batchId)
        external
        view
        returns (
            bytes32 id,
            bytes32 metadataHash,
            address registeredBy,
            uint64 registeredAt,
            BatchStatus status
        )
    {
        Batch storage b = _batches[batchId];
        return (b.id, b.metadataHash, b.registeredBy, b.registeredAt, b.status);
    }

    /// @notice Convenience predicate mirroring getBatch().status.
    function verifyBatch(bytes32 batchId) external view returns (bool registered, bool active) {
        Batch storage b = _batches[batchId];
        registered = b.status != BatchStatus.None;
        active = b.status == BatchStatus.Registered;
    }

    /// @notice Batch history is reconstructed from the emitted event log
    ///         (BatchRegistered / BatchRevoked / BatchReinstated) so the
    ///         contract never needs to rewrite past records.
    function getBatchHistory(bytes32 batchId) external view returns (BatchStatus status) {
        return _batches[batchId].status;
    }

    function batchExists(bytes32 batchId) external view returns (bool) {
        return _batches[batchId].status != BatchStatus.None;
    }

    // ---------------------------------------------------------------- transfers

    /**
     * @notice Initiate an inter-pharmacy transfer of an active batch.
     * @dev The contract validates addressing and batch state only. Stock
     *      reservation stays in the application database, which reconciles
     *      against this confirmed on-chain result.
     */
    function initiateTransfer(
        bytes32 transferId,
        bytes32 batchId,
        address destination,
        uint256 quantity
    ) external onlyPharmacy nonReentrant returns (bytes32) {
        if (transferId == bytes32(0)) revert BatchNotFound(transferId);
        if (_transfers[transferId].status != TransferStatus.None) revert TransferAlreadyExists(transferId);
        if (destination == address(0)) revert ZeroAddress();
        if (destination == msg.sender) revert SamePharmacy(msg.sender);
        if (!hasRole(PHARMACY_ROLE, destination)) revert NotPharmacy(destination);
        if (quantity == 0) revert ZeroQuantity();

        Batch storage batch = _batches[batchId];
        if (batch.status == BatchStatus.None) revert BatchNotFound(batchId);
        if (batch.status != BatchStatus.Registered) revert BatchNotActive(batchId);

        _transfers[transferId] = Transfer({
            id: transferId,
            batchId: batchId,
            from: msg.sender,
            to: destination,
            quantity: quantity,
            status: TransferStatus.Initiated,
            createdAt: uint64(block.timestamp),
            settledAt: 0
        });

        emit TransferInitiated(transferId, batchId, msg.sender, destination, quantity, uint64(block.timestamp));
        return transferId;
    }

    /// @notice Only the intended destination may confirm receipt.
    function confirmTransfer(bytes32 transferId) external onlyPharmacy nonReentrant {
        Transfer storage t = _requireInitiated(transferId);
        if (msg.sender != t.to) revert NotDestinationPharmacy(msg.sender, t.to);

        t.status = TransferStatus.Confirmed;
        t.settledAt = uint64(block.timestamp);
        emit TransferConfirmed(transferId, msg.sender, uint64(block.timestamp));
    }

    /// @notice Either endpoint may cancel while still in Initiated.
    function cancelTransfer(bytes32 transferId) external onlyPharmacy {
        Transfer storage t = _requireInitiated(transferId);
        if (msg.sender != t.from && msg.sender != t.to) {
            revert NotSourcePharmacy(msg.sender, t.from);
        }

        t.status = TransferStatus.Cancelled;
        t.settledAt = uint64(block.timestamp);
        emit TransferCancelled(transferId, msg.sender);
    }

    /// @notice Only the intended destination may reject receipt.
    function rejectTransfer(bytes32 transferId, bytes32 reasonHash) external onlyPharmacy {
        Transfer storage t = _requireInitiated(transferId);
        if (msg.sender != t.to) revert NotDestinationPharmacy(msg.sender, t.to);

        t.status = TransferStatus.Rejected;
        t.settledAt = uint64(block.timestamp);
        emit TransferRejected(transferId, msg.sender, reasonHash);
    }

    function getTransfer(bytes32 transferId)
        external
        view
        returns (
            bytes32 id,
            bytes32 batchId,
            address from,
            address to,
            uint256 quantity,
            TransferStatus status,
            uint64 createdAt,
            uint64 settledAt
        )
    {
        Transfer storage t = _transfers[transferId];
        return (t.id, t.batchId, t.from, t.to, t.quantity, t.status, t.createdAt, t.settledAt);
    }

    function _requireInitiated(bytes32 transferId) private view returns (Transfer storage t) {
        t = _transfers[transferId];
        if (t.status == TransferStatus.None) revert TransferNotFound(transferId);
        // Any settled state blocks further transitions, which makes a double
        // confirmation revert rather than silently overwrite.
        if (t.status != TransferStatus.Initiated) revert TransferAlreadySettled(transferId);
    }

    // ---------------------------------------------------------------- deliveries

    /**
     * @notice Record a delivery milestone against an opaque order reference.
     * @param orderRef keccak256 of the opaque order reference — never the
     *        customer's name, address or phone number.
     * @param milestone Must advance exactly one legal step from the current
     *        milestone. Replays are rejected.
     */
    function recordDeliveryEvent(bytes32 orderRef, uint8 milestone) external onlyDeliveryActor {
        if (orderRef == bytes32(0)) revert BatchNotFound(orderRef);
        if (milestone == 0 || milestone > uint8(Milestone.Delivered)) revert InvalidMilestone(milestone);

        Milestone next = Milestone(milestone);
        DeliveryState storage state = _deliveries[orderRef];

        // Strictly forward progress: an unknown order starts at Packed.
        if (state.lastMilestone == Milestone.None) {
            if (next != Milestone.Packed) revert MilestoneOutOfOrder(0, milestone);
        } else if (uint8(next) != uint8(state.lastMilestone) + 1) {
            revert MilestoneOutOfOrder(uint8(state.lastMilestone), milestone);
        }

        // Delivered is terminal; the ordering check above already prevents a
        // silent regression, this makes the intent explicit.
        if (state.lastMilestone == Milestone.Delivered) revert DeliveryAlreadyDelivered();
        if (_milestoneRecorded[orderRef][next]) revert MilestoneAlreadyRecorded(milestone);

        _milestoneRecorded[orderRef][next] = true;
        state.lastMilestone = next;
        state.updatedAt = uint64(block.timestamp);
        state.milestoneCount += 1;

        emit DeliveryMilestoneRecorded(orderRef, next, msg.sender, uint64(block.timestamp), state.milestoneCount);
    }

    function getDeliveryState(bytes32 orderRef)
        external
        view
        returns (Milestone lastMilestone, uint64 updatedAt, uint256 milestoneCount)
    {
        DeliveryState storage s = _deliveries[orderRef];
        return (s.lastMilestone, s.updatedAt, s.milestoneCount);
    }

    function hasMilestone(bytes32 orderRef, uint8 milestone) external view returns (bool) {
        if (milestone == 0 || milestone > uint8(Milestone.Delivered)) return false;
        return _milestoneRecorded[orderRef][Milestone(milestone)];
    }

    /// @notice True when the recorded order has reached Delivered.
    function isDelivered(bytes32 orderRef) external view returns (bool) {
        return _deliveries[orderRef].lastMilestone == Milestone.Delivered;
    }
}
