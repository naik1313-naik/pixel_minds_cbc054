# MediMesh Blockchain Audit Layer

A verifiable audit trail for medicine batches, inter-pharmacy transfers and
delivery milestones, running on a **local Hardhat EVM**.

This is an **additional module**, not a replacement. The existing Postgres
database, authentication, inventory, order, delivery, SSE and Leaflet
functionality are untouched and keep working when the chain is offline.

---

## 1. What this does and does not prove

This matters more than any feature below, so it is stated up front.

**It proves:**
- An authorized pharmacy wallet recorded a batch reference and a metadata hash.
- The recorded metadata has not been altered since (the hash is recomputed).
- No later event revoked that batch.
- An authorized actor reported a delivery milestone, in a valid order, exactly once.

**It does not prove:**
- That the physical medicine is genuine.
- Who actually manufactured it.
- That a parcel physically arrived anywhere.
- That the supplied metadata was truthful when it was submitted.

A hash proves *the data matches what was anchored*. It cannot prove the data was
true. Every user-facing surface repeats this distinction, and a missing chain
response is reported as `UNAVAILABLE`, never as "counterfeit".

---

## 2. Architecture

```
blockchain/                 Isolated Hardhat workspace (own package.json)
  contracts/MediMeshLedger.sol
  scripts/deploy.ts         writes deployments/local.json
  test/MediMeshLedger.test.ts

lib/blockchain/
  client.ts          JsonRpcProvider, per-address signers, sendTx + receipts
  ledger.ts          batches / transfers / delivery milestones
  transactions.ts    durable outbox + reconciliation
  hashes.ts          canonical, versioned metadata hashing
  abi.generated.json produced by scripts/generate-abi.mjs

app/api/blockchain/  status, batches, transfers, deliveries, reconcile
app/verify/[batchId] public QR verification page
components/blockchain/ status panel, batch panel, transfer panel, audit timeline
```

The Next.js server **never compiles Solidity**. It reads the ABI generated at
build time and the deployment manifest written by the deploy script.

---

## 3. The database is PostgreSQL, not SQLite

The original brief asked to keep "the existing SQLite/better-sqlite3 database".
**There is no SQLite in this repository.** Ground truth:

- `lib/db.ts` imports `Pool` from `pg`.
- `lib/schema.sql` uses `SERIAL`, `TEXT` timestamps and `paise` integers —
  Postgres syntax.
- Commit `0a9ba41` "feat: complete SQLite→Supabase migration".
- `data/medimesh.db` is a dead leftover file that no code reads.

The **intent** of that requirement — do not replace or migrate the database —
is honoured: the blockchain tables were added to the existing `lib/schema.sql`
and read through the existing `pg` pool. `README.md` still claims SQLite in a
few places; that is stale documentation, not a working SQLite setup.

---

## 4. Setup and run

Three terminals. Everything below is real; no simulated transactions.

### Terminal 1 — local chain
```bash
npm run chain:install     # once
npm run chain:node        # http://127.0.0.1:8545, chainId 31337
```

### Terminal 2 — contract
```bash
npm run chain:compile
npm run chain:test        # 43 tests
npm run chain:deploy      # writes blockchain/deployments/local.json
npm run abi:generate      # refreshes lib/blockchain/abi.generated.json
```

### Terminal 3 — app
```bash
npm run dev
```

Open http://localhost:3000. The **Batches** tab in the pharmacy console shows
a live connection panel.

### Redeploying after a chain restart

`npx hardhat node` starts with an empty chain, so a previously deployed address
is dead. The status panel detects this and says so. To fix:

```bash
# terminal 1
npm run chain:node
# terminal 2
npm run chain:deploy && npm run abi:generate
```

Old addresses are never reused or presented as valid.

---

## 5. Environment variables

See `.env.example`. All are optional — the app starts without them and reports
an honest "not configured" state.

| Variable | Purpose | Secret? |
|---|---|---|
| `BLOCKCHAIN_RPC_URL` | Local RPC, defaults to `http://127.0.0.1:8545` | No |
| `BLOCKCHAIN_CHAIN_ID` | Defaults to `31337` | No |
| `BLOCKCHAIN_PRIVATE_KEY` | Fallback signer for admin operations | **Yes** |
| `MEDIMESH_LEDGER_ADDRESS` | Overrides the manifest address | No |
| `MEDIMESH_DEPLOYMENT_FILE` | Overrides the manifest path | No |

### About signing keys

The contract enforces roles **per address**, so each pharmacy and delivery
wallet needs its own key — a single server key cannot represent eight
pharmacies. For the local demo, `scripts/deploy.ts` re-derives Hardhat's
**public** development keys from its default mnemonic and writes them into
`blockchain/deployments/local.json`.

These keys are:

- printed in plaintext by `npx hardhat node`;
- worth nothing and must never be funded;
- **gitignored** (`blockchain/deployments/`);
- **refused when `NODE_ENV=production`**, unless `MM_ALLOW_DEV_KEYS=true`
  (`lib/blockchain/client.ts` `getSignerFor`).

`BLOCKCHAIN_PRIVATE_KEY` is never prefixed with `NEXT_PUBLIC_`, never returned
by any endpoint, and never logged. `/api/blockchain/status` returns only a
boolean `signerConfigured`.

---

## 6. Smart contract

`MediMeshLedger.sol` — Solidity 0.8.24, OpenZeppelin `AccessControl` +
`ReentrancyGuard`.

### Roles
- `DEFAULT_ADMIN_ROLE` — authorize/revoke pharmacy and delivery wallets
- `PHARMACY_ROLE` — register batches, initiate/cancel/reject transfers
- `DELIVERY_ROLE` — record delivery milestones

Role changes emit events. Admin authorization is **only** performed by the admin.

### Batch registry (append-only)
- `registerBatch(bytes32 batchId, bytes32 metadataHash)` — rejects duplicates,
  empty ids and empty hashes
- `revokeBatch(bytes32)` / `reinstateBatch(bytes32)` — explicit state
  transitions, never silent overwrites. The original registrant and hash are
  preserved through revocation.
- `getBatch`, `verifyBatch`, `batchExists`
- History is reconstructed from `BatchRegistered` / `BatchRevoked` /
  `BatchReinstated` events.

### Transfer lifecycle
- `initiateTransfer(transferId, batchId, destination, quantity)` — source signs,
  destination must be an authorized pharmacy, quantity > 0, batch must be active
- `confirmTransfer` — **destination only**
- `cancelTransfer` — either endpoint, while Initiated
- `rejectTransfer(transferId, reasonHash)` — destination only

Any settled state makes further transitions revert, so a double confirmation
cannot silently succeed.

### Delivery audit
- `recordDeliveryEvent(bytes32 orderRef, uint8 milestone)` — must advance
  **exactly one** legal step; replays and regressions revert
- `getDeliveryState`, `hasMilestone`, `isDelivered`

---

## 7. What is on-chain vs off-chain

**On-chain:** opaque batch refs, metadata hashes, authorized wallet addresses,
transfer lifecycle, milestone timestamps, opaque order-ref hashes, events.

**Never on-chain:** customer names, phones, delivery addresses, prescriptions,
payments, supplier invoices, GPS traces.

GPS updates stay off-chain and keep flowing to Leaflet. Only four meaningful
milestones are anchored.

---

## 8. Reliability

SQLite/Postgres and the EVM do not share a transaction, so every on-chain write
follows a durable outbox in `blockchain_operations`:

1. Persist the operation as `Pending` — **before** any submission.
2. Mark `Submitted` and store the tx hash as soon as it is known.
3. Wait for a receipt, then mark `Confirmed`.

Statuses: `Pending`, `Submitted`, `Confirmed`, `Failed`, `NeedsReconciliation`.

If the process dies between 2 and 3, the operation stays `Submitted` and
`POST /api/blockchain/reconcile` (admin) resolves it by reading the receipt.
**Reconciliation never re-submits** — that is what prevents a retry from
double-applying stock or double-registering a batch.

Permanent failures (authorization, validation, duplicate) go straight to
`Failed` so they are never retried blindly. Transport uncertainty becomes
`NeedsReconciliation`.

### Idempotency
- A caller-supplied `idempotency-key` returns the original result without
  submitting a second transaction (verified in the smoke test).
- Transfer stock is claimed with `stock_applied 0 -> 1` inside one database
  transaction, so a retry cannot move stock twice.
- A delivery milestone is unique on `(delivery_id, milestone)`.
- Sends are serialized per sender address to avoid nonce collisions.

---

## 9. Verification and privacy

Metadata hashes use `solidityPackedKeccak256` over an ABI-packed, ordered,
schema-versioned field list. Variable-length strings are hashed to `bytes32`
first, so no two distinct field sets can collide by delimiter confusion
(`medicineName: "ab", salt: "c"` differs from `"a"` / `"bc"`).

Opaque references use `crypto.randomBytes` over a 32-character alphabet with
visually ambiguous characters (`I`, `L`, `O`, `U`) removed — ~100 bits of
entropy, never derived from predictable data.

QR codes encode only `{origin}/verify/{batchRef}`. The endpoint requires an
authenticated session and returns `Cache-Control: no-store`.

---

## 10. Test results

| Suite | Command | Result |
|---|---|---|
| Smart contract | `npm run chain:test` | **43 passing** |
| App unit tests | `npm test` | **106 passing** (7 files) |
| Type check | `npx tsc --noEmit` | clean |
| Lint | `npm run lint` | clean |
| Production build | `npm run build` | passes |
| Live E2E | `npm run smoke:blockchain` | **32 checks, 0 failures** |
| Live delivery audit | `npm run smoke:delivery` | **12 checks, 0 failures** |

The live suites perform **real** transactions against the local node and verify
each hash by reading its receipt back over JSON-RPC. They fail loudly rather
than reporting unverified success.

Pre-existing app tests were untouched; all still pass, so there are no
regressions from this integration.

---

## 11. Known limitations

1. **The deployed Vercel app does not use blockchain.** `medimesh-nu.vercel.app`
   cannot reach `127.0.0.1:8545`. Every blockchain feature is local-only until a
   reachable RPC is configured. Do not expose a localhost RPC publicly.
2. **A restarted local node loses all chain state.** Application rows survive
   (Postgres), so batches may show `Registered` locally while the chain reports
   `NOT_FOUND`. That is reported honestly rather than papered over.
3. **`BL_ALLOW_DEV_KEYS` escape hatch** exists for local production-mode
   testing. Leaving it unset keeps dev keys refused in production.
4. **Batch authenticity is not proven** — see section 1.
5. Milestones are anchored when reported, not when physically observed.
6. The demo wallet mapping is pharmacy-id based (`1..8`), matching the seed data.
   A pharmacy with an id above 8 has no mapped wallet and gets a clear error.
