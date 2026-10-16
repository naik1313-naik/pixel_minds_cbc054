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
| `MM_WALLET_KEYS` | `{address: privateKey}` map for a public chain | **Yes** |

### Running on a public chain

The default is a local Hardhat node, which is fine for a demonstration and
means the whole audit layer works offline. To anchor settlements on a chain that
is not this laptop, Base Sepolia is the sensible target: it is an EVM chain with
a free faucet, so nothing here costs anything.

```bash
cd blockchain
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org \
MM_DEPLOYER_PRIVATE_KEY=0x... \
MM_CONFIRM_PUBLIC_DEPLOY=yes \
npx hardhat run scripts/deploy-public.ts --network baseSepolia
```

Then point the app at the manifest the script writes:

```bash
BLOCKCHAIN_RPC_URL=https://sepolia.base.org
BLOCKCHAIN_CHAIN_ID=84532
MEDIMESH_DEPLOYMENT_FILE=./blockchain/deployments/baseSepolia.json
MM_WALLET_KEYS='{"0xYourPharmacyWallet":"0x...key..."}'
```

`deploy-public.ts` deliberately refuses several things the local script does:

- it writes **no private keys** to disk — a public deployment must not leave key
  material next to the ABI in a JSON file;
- it refuses to deploy from Hardhat's default mnemonic, by deriving that
  mnemonic's 20 addresses and comparing;
- it refuses to deploy from an unfunded account, since deployment needs gas;
- it requires `MM_CONFIRM_PUBLIC_DEPLOY=yes`, so an accidental invocation cannot
  leave a contract behind that nobody meant to create.

Because roles are enforced per address, each pharmacy still has to sign **its
own** settlements from its own wallet. `MM_WALLET_KEYS` is the stand-in for the
KMS or HSM an operator would really use; the indirection is the same, the key
simply never sits in a repository. A key filed under the wrong address is
rejected rather than used — `envWalletFor` verifies the derivation before
handing a key back.

Nothing about the ledger's guarantees changes with the chain. It is still an
audit anchor and nothing else; see the limitations section below.

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

### Settlement audit (payments)
- `recordSettlement(bytes32 settlementId, bytes32 orderRef, bytes32 settlementHash, uint256 amountPaise, address beneficiary)`
  — append-only: a settlement reference can be anchored **once**; replays revert
  with `SettlementAlreadyRecorded`. The beneficiary must hold `PHARMACY_ROLE`,
  so a settlement can only ever be attributed to a pharmacy the contract has
  authorized.
- `getSettlement`, `settlementExists`
- Rejects zero amounts, empty references and the zero address.

> The contract stores **no value** and cannot see the payment rail. It records
> that an authorized wallet *reported* a settlement of amount A for order B to
> pharmacy C at time T. It is not a bank statement, and the UI must not present
> it as one.

---

## 7. What is on-chain vs off-chain

**On-chain:** opaque batch refs, metadata hashes, authorized wallet addresses,
transfer lifecycle, milestone timestamps, opaque order-ref hashes, settlement
ids / hashes / amounts, events.

**Never on-chain:** customer names, phones, delivery addresses, prescriptions,
gateway order or payment ids, bank or card details, supplier invoices, GPS
traces.

GPS updates stay off-chain and keep flowing to Leaflet. Only four meaningful
milestones are anchored.

---

## 6b. Payments and settlement

Money flows through Razorpay; the chain is an audit trail for it, never a rail.

```
pharmacy confirms order ─> payment intent (amount frozen server-side)
customer pays ──────────> gateway captures, routing the pharmacy owner's
                           share to their own linked account
order fulfilled ─────────> payment PaidOut + settlement anchored on-chain
```

- **Amounts** are integer paise throughout. The order total is computed from the
  catalogue price at confirm time — never from anything the client sends.
- **Split**: `platform_fee = round(total × 0.05)`; the pharmacy receives
  `total − fee`. Rounding happens once, so the two always reconstruct the total.
- **Money never rests in a MediMesh balance** beyond the platform fee. Capture is
  refused outright if the pharmacy has no activated payout account.
- **Bank details** are entered on Razorpay's hosted onboarding page. This
  database stores only the resulting account id and its status.
- **Degradation is asymmetric on purpose**: a chain outage must not block a
  delivery, so the settlement anchor is best-effort and retried by the
  reconciliation job; a gateway outage *does* block capture, because taking money
  without a record is worse than a delayed delivery.

### Payment invariants (all covered by `tests/payments.test.ts`)
- A payment intent is created once and reused — a retried "Pay now" cannot
  double-charge.
- A repeated checkout callback does not route money twice.
- A forged checkout signature is rejected before any capture is attempted.
- Both completion paths (pickup `completeRequest` and delivered
  `finalizeDeliveredRequest`) settle idempotently, via a guarded
  `UPDATE … WHERE status = 'Captured'`.
- Cancelling refunds a captured payment and closes an uncaptured one without
  calling the gateway.
- The merchant key secret never appears in any API payload.

---

## 6c. Verifying a settlement publicly

`/verify/settlement/<settlementRef>` — unauthenticated by design, because the point of anchoring is
that a customer or a third party can check it themselves.

Three independent checks, so the page never merely restates our database:

1. `hashRef(settlementRef)` resolves to a settlement present on-chain.
2. The on-chain `settlementHash` is compared against a hash **recomputed** from
   `payment_audit.metadata_json`. This is what makes "record unaltered" a proof rather than a claim,
   and it is why the canonical metadata is stored rather than only its hash.
3. The displayed amount and beneficiary come from the chain, so editing a local row cannot change what
   the page reports.

Outcomes, and the wording each one is allowed to use:

| Status | Says |
|---|---|
| `SETTLED` | Reported by an authorized pharmacy wallet, record unaltered — **and** that this does not prove a bank transfer |
| `MISMATCH` | Disputed; do not rely on it, escalate to the pharmacy |
| `NOT_FOUND` | No such record — explicitly *not* evidence a pharmacy withheld payment |
| `PENDING` | Recorded locally, chain anchor not confirmed yet (usually a dead RPC) |
| `UNAVAILABLE` | Could not reach the chain |

A verification surface that only ever prints a green tick becomes marketing. Every success carries its
own limit.

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
7. **A settlement anchor does not prove a bank transfer happened.** It proves an
   authorized pharmacy wallet reported the settlement and that the record has not
   changed since. The payment gateway, not the chain, is the evidence of money.
8. **Webhook reliability depends on `MM_RAZORPAY_WEBHOOK_SECRET`.** Without it
   `/api/webhooks/razorpay` rejects every request. The browser callback is a
   convenience only — a customer who closes the tab still gets captured, but
   only once a webhook is configured.
