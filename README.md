# MediMesh

**Medicine availability, reservation & delivery network.** A customer requests a medicine;
MediMesh ranks nearby verified pharmacies by distance, stock confidence, response time and
fulfilment history, soft-locks stock atomically, borrows from peer pharmacies when the preferred
one is short, and delivers it — with live rider tracking, an OTP-verified handover, a transparent
inter-pharmacy ledger and a full audit trail.

Four role-based apps (customer, pharmacy, delivery partner, admin) over a single SQLite source of
truth. No external accounts, API keys or cloud — a self-contained local prototype.

---

## Stack

| Layer     | Choice |
|-----------|--------|
| Framework | Next.js 15 (App Router) + TypeScript (strict) |
| Styling   | Tailwind CSS 3 |
| Database  | SQLite via `better-sqlite3` (WAL, single file, auto-created + seeded on first run) |
| Auth      | `@node-rs/argon2` (argon2id) + server-side sessions + RFC-6238 TOTP 2FA |
| Realtime  | Server-Sent Events (SSE) over an in-process event bus |
| Maps      | Leaflet + OpenStreetMap (`react-leaflet`, client-only via `next/dynamic`) |
| Validation| `zod` |
| Tests     | `vitest` (unit/integration) + `@playwright/test` (e2e, desktop + mobile) |

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. On first run the app creates `data/medimesh.db`, applies the schema
and seeds 8 Bengaluru pharmacies, 24 medicines and demo users for every role.

**Demo credentials** are printed to the server terminal and written to `data/.demo-credentials.txt`
(git-ignored). Passwords are random per seed run and regenerate on every **Reset**. Accounts with
2FA enabled (`admin`, `owner1`) also get a TOTP secret there — add it to an authenticator app, or
use the e2e/acceptance helpers which compute codes automatically.

> Use `npm run dev` for local demos. `npm run start` (production) intentionally **refuses to boot
> without secrets** — see [Secrets](#secrets). Dev auto-generates throwaway secrets under
> `data/.dev-secrets.json`.

---

## Pages & apps (by role)

| Route | Role | What it does |
|-------|------|--------------|
| `/` | public | Animated landing page: live network stats + value proposition |
| `/login`, `/register`, `/pharmacy/register`, `/rider/register` | public | Sign in / customer sign-up / pharmacy & rider onboarding |
| `/app` | customer | Search a medicine, see ranked availability, reserve (pickup or delivery), track live |
| `/app/request/[id]` | customer | Request timeline, split/partial details, live delivery map, demo OTP reveal, cancel/collect |
| `/pharmacy` | pharmacy_owner / staff | Incoming requests (verify Rx / confirm / reject / ready), inventory editor, borrow ledger, active deliveries |
| `/rider` | delivery_partner | Go online, accept/decline job offers, advance the delivery state machine, run the location simulator, OTP + ID handover |
| `/admin` | admin | Overview metrics, verify pharmacies & partners, users, audit log, demo controls |
| `/insights` | staff roles | Network-wide demand, low stock, expiries, lost sales, ledger totals, pharmacy performance |

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `MM_DATA_DIR` | Override the runtime data directory (defaults to `./data`). Used by tests. |
| `DEMO_MODE` | `1`/`true` (or any non-production `NODE_ENV`) enables demo affordances: terminal SMS, demo OTP reveal, location telemetry bypass. |
| `LOCK_MINUTES` | Default reservation lock expiry in minutes (default 30). The demo toggle switches to 20 seconds. |
| `MM_QUIET` | `1` suppresses seed/credential console output. |
| `APP_ENCRYPTION_KEY` | AES-256-GCM key (hex) for encrypting TOTP secrets and ID numbers. **Required in production.** |
| `SESSION_PEPPER` | HMAC pepper for session-token hashing. **Required in production.** |
| `MM_KYC_ENDPOINT` | If set, document checks are routed to a real KYC/eKYC gateway (POST JSON) instead of the offline demo provider. |
| `MM_KYC_API_KEY` | Bearer token sent to `MM_KYC_ENDPOINT`. |

### Secrets

No secret is hard-coded. In development, `requireSecret()` auto-generates missing secrets into
`data/.dev-secrets.json` (git-ignored). In production it throws if `APP_ENCRYPTION_KEY` or
`SESSION_PEPPER` are unset. TOTP secrets are stored AES-256-GCM-encrypted (`crypto.ts`).

---

## Data model

```
pharmacies(id, name, address, lat, lng, drug_licence_no, verification_status, response_score, fulfilment_count,
           licence_verified, licence_checked_at, licence_meta_json)
medicines(id, name, salt, price_paise, rx_required)
inventory(pharmacy_id, medicine_id, qty_total, qty_locked, expiry_date)
requests(id, customer_id, customer_name, medicine_id, qty, secured_qty, preferred_pharmacy_id,
         fulfilment_type, delivery_address, delivery_lat, delivery_lng, status, rx_verified,
         substitute_for_id, idempotency_key, created_at)
reservations(id, request_id, pharmacy_id, qty, lock_expires_at, status, kind)
ledger(id, from_pharmacy_id, to_pharmacy_id, medicine_id, qty, wholesale_amount, platform_fee, created_at)
lost_sales(id, medicine_id, area, qty, value, created_at)
demand_events(id, medicine_id, area, qty, created_at)
deliveries(id, request_id, pharmacy_id, partner_id, status, destination_address, destination_lat,
           destination_lng, rx_required, distance_km, eta_minutes, otp_hash, otp_enc, otp_expires_at,
           otp_attempts, id_checked, proof_json, ...timestamps)
delivery_offers(id, delivery_id, partner_id, status, offered_at, expires_at)
delivery_location(id, delivery_id, partner_id, lat, lng, heading, speed_mps, recorded_at)
users(id, email, name, phone, password_hash, role, pharmacy_id, totp_secret_enc, totp_enabled,
      vehicle_number, id_type, id_last4, id_number_enc, doc_status, doc_checked_at, doc_meta_json,
      partner_online, partner_status, rating, failed_attempts, locked_until, ...)
sessions(id, token_hash, user_id, role, ip, user_agent, created_at, last_seen_at, expires_at, revoked)
recovery_codes, login_attempts, audit_log, settings
```

**Money is stored as integer paise** and formatted for display. All timestamps are UTC ISO strings.

Request lifecycle:
`Requested → Sourcing → Confirmed → Ready → (Completed | delivery states)`, with side states
`NeedsVerification` (Rx gate), `PartialOffer` (short stock), `Unavailable`, `Rejected`, `Expired`,
`Cancelled`.

Delivery state machine:
`SearchingPartner → AwaitingPharmacyApproval → Assigned → ArrivedAtPharmacy → PickedUp → OutForDelivery
→ ArrivedAtDestination → Delivered`, plus `HandoverFailed`, `CustomerUnreachable`, `ReturnedToPharmacy`,
`Cancelled`.

---

## How the engine works

All mutations run inside `better-sqlite3` transactions.

1. **Matching** — each pharmacy is scored
   `0.4·(1/distance_km) + 0.3·stock_confidence + 0.2·response_score + 0.1·fulfilment_history`
   from a fixed customer location (Indiranagar, Bengaluru), with an expiry tie-break.
2. **Soft-lock** — an atomic conditional UPDATE:
   `... SET qty_locked = qty_locked + :qty WHERE (qty_total - qty_locked) >= :qty AND (expiry ok)`.
   If 0 rows change, the lock failed; a reservation row is stored with `lock_expires_at`.
3. **Confirm** — decrements `qty_total`/`qty_locked`, writes demand; **Reject/expire** releases the
   lock and re-sources from the next pharmacy.
4. **Borrow** — if the preferred pharmacy is short, the shortfall is auto-borrowed from the best
   peer; a `ledger` row records wholesale (85% of price) plus a 5% platform fee.
5. **Split / PartialOffer** — quantity larger than one store is split; if the network is short, the
   secured part is offered and the rest is flagged.
6. **Unavailable** — logs a `lost_sales` row and suggests same-salt substitutes (pharmacist approval
   required).
7. **Idempotency** — `POST /api/requests` accepts an `idempotency-key` header; replays return the
   same request.
8. **Expiry sweep** — `sweepExpired()` runs at the start of API calls, releasing timed-out locks.

### Delivery

- A delivery is created when a pharmacy marks a request **Ready** (for delivery requests).
- Jobs are **offered one partner at a time** (30s window); `acceptOffer` is a single-winner atomic
  UPDATE so only one rider can claim a job.
- A rider's acceptance moves the job to **`AwaitingPharmacyApproval`**; the owning pharmacy (or an
  admin) must then **approve** it via `POST /api/pharmacy/deliveries/[id]/approve` to reach
  `Assigned`. Rejecting (`/reject`) clears the rider, records the offer as rejected and re-offers the
  job so the same rider is never offered twice.
- Riders stream location; the pipeline validates ownership, delivery state, coordinate bounds, a
  minimum interval (`1200ms`) and a teleport guard (`MAX_SPEED_MPS = 45`, bypassed in DEMO_MODE).
- Handover uses a 4-digit OTP stored as `otp_hash` (HMAC + pepper) with a DEMO-only encrypted copy
  for on-screen reveal, a 30-minute TTL and 5 attempts, gated by a 150m geofence
  (`GEOFENCE_METERS`). Prescription deliveries additionally require `idChecked`.
- Location histories older than 24h are purged after terminal states.

### Realtime

`lib/sse.ts` is a global event emitter. Request/delivery/pharmacy/location events are published to
per-entity channels. Clients subscribe with `useEventStream`; the request stream forwards both
request-status and linked delivery-location events so customers see live tracking.

---

## Identity & document verification

When someone creates a pharmacy or a rider account, their document number is verified
**before the account is created** (`lib/identity.ts` + `lib/providers.ts`). The check has two layers:

1. **Structure + checksum** (offline, deterministic):

   | Document | Rule |
   |---|---|
   | Aadhaar | 12 digits, first digit 2–9, **Verhoeff checksum** (the real UIDAI algorithm) |
   | PAN | `AAAAA9999A` with a valid 4th-character holder type |
   | Driving licence | state(2) + RTO(2) + year(4) + serial(7), year in range |
   | Voter / EPIC | 3 letters + 7 digits |
   | Passport | 1 letter + 7 digits |
   | Drug licence | Indian retail/wholesale layout, e.g. `KA-BLR-20B-12345` |

2. **Registry lookup** via a swappable `IdentityProvider` — confirms the number was actually
   issued (the demo provider is deterministic and rejects fabricated numbers).

Call `POST /api/identity/verify` (public, rate-limited) for a live answer; the rider sign-up form
uses it behind a **Verify** button. Outcomes are `verified`, `invalid` (bad checksum / not issued),
`format_error` (wrong shape) or `unverifiable` (registry unreachable — routed to manual review rather
than rejected). Full ID numbers are **encrypted at rest** (`id_number_enc`, AES-256-GCM) and only a
masked form (`XXXX XXXX 1234`) is ever stored for display or returned by the API. The result is
stored on the row (`doc_status` / `licence_verified`) and shown to admins, who still give the final
approval. Set `MM_KYC_ENDPOINT`/`MM_KYC_API_KEY` to route checks to a real gateway — no other change.

---

## Security

- **Passwords**: argon2id (`memoryCost 19456`, `timeCost 2`, `parallelism 1`).
- **Sessions**: server-side, opaque random tokens stored hashed (HMAC + pepper); sliding idle
  timeout (60 min) + absolute lifetime (12h); listed and revocable from `/api/auth/sessions`.
- **2FA**: RFC-6238 TOTP (30s, SHA-1, 6 digits) with 10 single-use recovery codes; required for
  `admin`/`owner1`.
- **Rate limiting & lockout**: per-IP login attempts with account lockout.
- **RBAC**: `guard([roles])` wraps every mutating route; `lib/access.ts` enforces row-level
  visibility for requests and deliveries.
- **CSRF**: `SameSite=Lax` cookies plus a same-origin check on mutating requests.
- **Audit log**: every sensitive action is recorded (`actor`, `action`, `entity`, `ip`).

---

## Seed highlights (for the demo)

| Medicine | Why it matters |
|---|---|
| Paracetamol / Dolo / Crocin | share salt (Acetaminophen) → substitutes |
| Ibuprofen / Brufen | share salt (Ibuprofen) → substitutes |
| Crocin Advance | **out of stock everywhere** → lost sale + substitutes |
| Domperidone 10 | only **5 units** network-wide → competing customers |
| Cough Syrup 100ml | preferred pharmacy has 0, a peer has stock → borrow + ledger |
| Amoxicillin 500 (rx) | requires pharmacist verification before confirm |
| Selected low stock | #20 (2), #19 (4), #10 (3), #17 (5) — split / partial demos |

Pharmacies 1–7 are verified; pharmacy 8 and rider 4 are **pending** (to demo admin verification).
All seeded pharmacies carry a valid-looking drug licence (`KA-BLR-20B-000n`) and riders a verified
ID (DL or a Verhoeff-valid Aadhaar), so the admin console shows green document badges.

---

## Testing & quality gates

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (next/core-web-vitals)
npm test            # vitest — engine, delivery, auth, security, identity/providers (62 tests)
npm run acceptance  # end-to-end API script (needs a running server: BASE=http://localhost:3000)
npm run e2e:install # one-time: download Chromium for Playwright
npm run e2e         # Playwright e2e, desktop + mobile
npm run build       # production build
npm run db:inspect  # print migrations, row counts, pharmacy/partner verification
npm run db:reset    # delete the DB so the next app start reseeds it
```

`scripts/acceptance.mjs` drives the full lifecycle — customer search → request → pharmacy
confirm/ready → rider accept/advance/location → customer demo-OTP reveal → rider handover →
Completed — and asserts idempotency, illegal-transition rejection, RBAC and anonymous-access
blocking (25 checks). Playwright specs cover the landing page, auth redirect, the customer journey,
rider sign-up document verification, and each role console on desktop and mobile viewports.

### Note on TOTP

`otplib` v13 is broken (`generate` works but `verify` throws `SecretMissingError`), so it was
removed. TOTP is implemented directly in `lib/crypto.ts` (RFC-6238) and validated against the
published RFC 6238 test vector.

---

## Architecture

- **`lib/db.ts`** — connection singleton, schema/migrations, seed-on-empty, `settings`/`resetDemo`.
- **`lib/crypto.ts`** — AES-256-GCM, HMAC, secret management, RFC-6238 TOTP.
- **`lib/auth.ts` / `lib/session.ts`** — passwords, sessions, 2FA, rate limits, cookie helpers.
- **`lib/engine.ts`** — scoring, atomic locks, sourcing, confirm/reject/verify/ready, borrowing,
  substitutes, analytics.
- **`lib/delivery.ts`** — offers, state machine, location pipeline, OTP/handover, retention, demo
  stepping.
- **`lib/api-utils.ts` / `lib/access.ts` / `lib/validation.ts`** — guard/RBAC, row-level access,
  zod schemas.
- **`lib/sse.ts` / `lib/useEventStream.ts`** — server event bus + client subscription.
- **`lib/providers.ts`** — swappable SMS / routing / payment / identity providers (console in DEMO_MODE).
- **`lib/identity.ts`** — document format + Verhoeff checksum validation, masking, registry lookup.
- **`app/api/**`** — thin handlers that validate and delegate; **`components/**`** — role apps and
  UI; **`app/**`** — route pages.

The "never oversell" guarantee is a property of one atomic SQL statement, not application-level
locking.

> **Prototype.** Substitutes are suggestions only and require pharmacist approval. All data is
> fictional.
