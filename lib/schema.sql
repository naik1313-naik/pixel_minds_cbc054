-- MediMesh PostgreSQL schema (Supabase-compatible).
-- Money is stored in integer paise. Timestamps are UTC ISO strings.
-- Safe to run repeatedly (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS pharmacies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  drug_licence_no TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  response_score DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  fulfilment_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  licence_verified TEXT,
  licence_checked_at TEXT,
  licence_meta_json TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  pharmacy_id INTEGER REFERENCES pharmacies(id),
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  vehicle_number TEXT,
  id_type TEXT,
  id_last4 TEXT,
  partner_online INTEGER NOT NULL DEFAULT 0,
  partner_status TEXT,
  rating DOUBLE PRECISION NOT NULL DEFAULT 4.8,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  id_number_enc TEXT,
  doc_status TEXT,
  doc_checked_at TEXT,
  doc_meta_json TEXT
);

CREATE TABLE IF NOT EXISTS medicines (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  price_paise INTEGER NOT NULL,
  rx_required INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  qty_total INTEGER NOT NULL DEFAULT 0,
  qty_locked INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT,
  PRIMARY KEY (pharmacy_id, medicine_id),
  CHECK (qty_locked >= 0 AND qty_locked <= qty_total)
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER,
  customer_name TEXT NOT NULL,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  qty INTEGER NOT NULL,
  secured_qty INTEGER NOT NULL DEFAULT 0,
  preferred_pharmacy_id INTEGER,
  fulfilment_type TEXT NOT NULL DEFAULT 'pickup',
  delivery_address TEXT,
  delivery_lat DOUBLE PRECISION,
  delivery_lng DOUBLE PRECISION,
  status TEXT NOT NULL,
  rx_verified INTEGER NOT NULL DEFAULT 0,
  rx_verified_by INTEGER,
  substitute_for_id INTEGER,
  idempotency_key TEXT UNIQUE,
  amount_paise INTEGER,                       -- canonical customer total, frozen at confirm
  platform_fee_paise INTEGER,                 -- MediMesh fee carved out of amount_paise
  payment_status TEXT,                        -- NULL until confirm; Awaiting | Captured | PaidOut | Refunded | Failed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  pharmacy_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  lock_expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id SERIAL PRIMARY KEY,
  request_id INTEGER,
  from_pharmacy_id INTEGER NOT NULL,
  to_pharmacy_id INTEGER NOT NULL,
  medicine_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  wholesale_amount INTEGER NOT NULL,
  platform_fee INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lost_sales (
  id SERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL,
  pharmacy_id INTEGER,
  qty INTEGER NOT NULL,
  value INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demand_events (
  id SERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL,
  area TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL UNIQUE,
  pharmacy_id INTEGER NOT NULL,
  partner_id INTEGER,
  status TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  destination_lat DOUBLE PRECISION NOT NULL,
  destination_lng DOUBLE PRECISION NOT NULL,
  rx_required INTEGER NOT NULL DEFAULT 0,
  distance_km DOUBLE PRECISION,
  eta_minutes DOUBLE PRECISION,
  assigned_at TEXT,
  accepted_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT,
  otp_hash TEXT,
  otp_enc TEXT,
  otp_expires_at TEXT,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  id_checked INTEGER NOT NULL DEFAULT 0,
  proof_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES requests(id)
);

CREATE TABLE IF NOT EXISTS delivery_offers (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  partner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered',
  offered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_location (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  partner_id INTEGER NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  heading DOUBLE PRECISION,
  speed_mps DOUBLE PRECISION,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  ip TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  meta_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  email TEXT,
  ip TEXT,
  success INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- =============================================================
-- Blockchain audit layer (MediMeshLedger)
--
-- SQLite/Postgres stays the operational source of truth. These tables hold
-- only non-sensitive data: opaque references, metadata hashes and transaction
-- pointers. No customer PII is stored here.
-- =============================================================

-- Medicine batches. Metadata JSON holds non-sensitive catalogue fields only.
CREATE TABLE IF NOT EXISTS medicine_batches (
  id SERIAL PRIMARY KEY,
  batch_ref TEXT NOT NULL UNIQUE,           -- opaque, e.g. MM-7QK4-2F9D-A1B2-C3D4E5F6
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  quantity_units INTEGER NOT NULL,
  expiry_date TEXT NOT NULL,
  manufactured_at TEXT NOT NULL,
  supplier_ref TEXT NOT NULL,
  metadata_json TEXT NOT NULL,              -- canonical non-sensitive metadata
  metadata_hash TEXT NOT NULL,              -- keccak256 of canonical encoding
  batch_id_hash TEXT NOT NULL UNIQUE,       -- keccak256(batch_ref), the on-chain key
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Submitted | Registered | Revoked | Failed | NeedsReconciliation
  tx_hash TEXT,
  block_number INTEGER,
  tx_operation_id INTEGER,                  -- -> blockchain_operations.id
  error TEXT,
  registered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pharmacy-to-pharmacy transfers. Stock movement is applied by the
-- application; the chain records the agreed lifecycle only.
CREATE TABLE IF NOT EXISTS batch_transfers (
  id SERIAL PRIMARY KEY,
  transfer_ref TEXT NOT NULL UNIQUE,        -- opaque
  transfer_id_hash TEXT NOT NULL UNIQUE,    -- keccak256(transfer_ref), on-chain key
  batch_id INTEGER NOT NULL REFERENCES medicine_batches(id),
  from_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  to_pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Initiated', -- Initiated | Confirmed | Rejected | Cancelled | Failed
  stock_applied INTEGER NOT NULL DEFAULT 0, -- idempotency guard: 1 once applied
  tx_hash TEXT,
  block_number INTEGER,
  confirm_tx_hash TEXT,
  confirm_block_number INTEGER,
  tx_operation_id INTEGER,
  confirm_operation_id INTEGER,
  reject_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  updated_at TEXT NOT NULL
);

-- Delivery milestone audit trail linked to the existing deliveries table.
CREATE TABLE IF NOT EXISTS delivery_audit (
  id SERIAL PRIMARY KEY,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  order_ref TEXT NOT NULL,                  -- opaque
  order_ref_hash TEXT NOT NULL,             -- keccak256(order_ref), on-chain key
  milestone TEXT NOT NULL,                  -- Packed | PickedUp | OutForDelivery | Delivered
  milestone_code INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_role TEXT NOT NULL,
  actor_wallet TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  tx_operation_id INTEGER,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Recorded | Failed
  error TEXT,
  created_at TEXT NOT NULL
);

-- Durable outbox for blockchain operations. An operation row is persisted
-- BEFORE any transaction is submitted so an uncertain outcome can always be
-- reconciled instead of blindly retried.
CREATE TABLE IF NOT EXISTS blockchain_operations (
  id SERIAL PRIMARY KEY,
  operation_ref TEXT NOT NULL UNIQUE,       -- internal, opaque
  operation_type TEXT NOT NULL,             -- batch.register | batch.revoke | transfer.initiate
                                           -- | transfer.confirm | transfer.reject | delivery.milestone
  entity_type TEXT NOT NULL,                -- batch | transfer | delivery
  entity_id INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,              -- caller-supplied dedupe key
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Submitted | Confirmed | Failed | NeedsReconciliation
  tx_hash TEXT,
  block_number INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT
);

-- Idempotent column additions for later schema versions.
--
-- Columns added after a table first shipped MUST be listed here rather than
-- inline in the CREATE TABLE above: CREATE TABLE IF NOT EXISTS is a no-op for
-- an existing table, so an inline addition silently never reaches a deployed
-- database and the app fails at runtime on a missing column.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS amount_paise INTEGER;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS platform_fee_paise INTEGER;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_checked_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_meta_json TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_verified TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_checked_at TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_meta_json TEXT;

-- =============================================================
-- Payments (Razorpay)
--
-- The database is the operational source of truth for money. Only opaque
-- gateway references are stored: a Razorpay order/payment id is a merchant
-- reference, never customer PII. No card, UPI or bank detail ever lands here —
-- those stay inside the gateway's PCI-scoped checkout.
--
-- Money is credited to the pharmacy owner's own linked Razorpay account via a
-- transfer at capture time, so funds never rest in MediMesh's account beyond
-- the platform fee.
-- =============================================================

-- Linked payout account for a pharmacy owner (Razorpay linked account id).
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS payout_account_status TEXT; -- pending | submitted | activated | rejected
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS payout_account_checked_at TEXT;

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  customer_id INTEGER REFERENCES users(id),
  pharmacy_id INTEGER REFERENCES pharmacies(id),
  amount_paise INTEGER NOT NULL,             -- what the customer pays
  platform_fee_paise INTEGER NOT NULL,       -- MediMesh fee (retained)
  pharmacy_amount_paise INTEGER NOT NULL,   -- routed to the pharmacy owner
  currency TEXT NOT NULL DEFAULT 'INR',
  gateway TEXT NOT NULL DEFAULT 'razorpay',
  status TEXT NOT NULL DEFAULT 'Created',   -- Created | Awaiting | Captured | PaidOut | Refunded | Cancelled | Failed
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_transfer_id TEXT,
  beneficiary_account_id TEXT,              -- pharmacy owner's linked account at capture time
  failure_reason TEXT,
  captured_at TEXT,
  paid_out_at TEXT,
  refunded_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (request_id)
);

-- Blockchain audit trail for a settled payment. Mirrors delivery_audit: the
-- chain proves *that* a settlement was reported by an authorized actor and
-- when, never that the underlying bank transfer was genuine.
-- Disputes, for when a customer is not satisfied *after* the money has moved.
--
-- A refund only works while the payment is still refundable. Once the payout
-- has been released to the pharmacy, returning the money is a recovery from the
-- pharmacy, not a gateway call — so it is recorded as an obligation rather than
-- faked as a successful refund. `recoverable_paise` is what the pharmacy owes
-- MediMesh if a dispute resolves in the customer's favour.
CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  payment_id INTEGER REFERENCES payments(id),
  raised_by INTEGER REFERENCES users(id),
  raised_by_role TEXT NOT NULL,
  category TEXT NOT NULL,             -- not_delivered | wrong_item | damaged | overcharged | other
  reason TEXT NOT NULL,               -- the customer's own words
  status TEXT NOT NULL DEFAULT 'Open',-- Open | Responded | RefundApproved | Rejected | Withdrawn
  response TEXT,                      -- pharmacy's reply
  responded_by INTEGER REFERENCES users(id),
  responded_at TEXT,
  resolution TEXT,                    -- admin's decision note
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  recoverable_paise INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_audit (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  settlement_ref TEXT NOT NULL UNIQUE,       -- opaque
  settlement_ref_hash TEXT NOT NULL UNIQUE,  -- keccak256(settlement_ref), on-chain key
  order_ref TEXT NOT NULL,                   -- opaque order reference
  order_ref_hash TEXT NOT NULL,              -- keccak256(order_ref), on-chain key
  amount_paise INTEGER NOT NULL,
  beneficiary_wallet TEXT,
  pharmacy_id INTEGER REFERENCES pharmacies(id),
  actor_user_id INTEGER REFERENCES users(id),
  actor_role TEXT NOT NULL,
  gateway_ref_hash TEXT NOT NULL,            -- keccak256 of the gateway settlement ref
  metadata_hash TEXT NOT NULL,
  metadata_json TEXT,                        -- canonical settlement metadata, for off-chain re-verification
  status TEXT NOT NULL DEFAULT 'Pending',    -- Pending | Submitted | Settled | Failed | NeedsReconciliation
  tx_hash TEXT,
  block_number INTEGER,
  tx_operation_id INTEGER,
  error TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Blockchain audit layer indexes.
CREATE INDEX IF NOT EXISTS idx_batches_pharmacy ON medicine_batches (pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_batches_status ON medicine_batches (status);
CREATE INDEX IF NOT EXISTS idx_batches_medicine ON medicine_batches (medicine_id);
CREATE INDEX IF NOT EXISTS idx_transfers_batch ON batch_transfers (batch_id);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON batch_transfers (from_pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON batch_transfers (to_pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON batch_transfers (status);
CREATE INDEX IF NOT EXISTS idx_delivery_audit_delivery ON delivery_audit (delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_audit_order ON delivery_audit (order_ref);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_audit_unique
  ON delivery_audit (delivery_id, milestone);
CREATE INDEX IF NOT EXISTS idx_bc_ops_status ON blockchain_operations (status);
CREATE INDEX IF NOT EXISTS idx_bc_ops_entity ON blockchain_operations (entity_type, entity_id);

-- Payment indexes.
CREATE INDEX IF NOT EXISTS idx_payments_pharmacy ON payments (pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payment_audit_payment ON payment_audit (payment_id);
-- Dispute indexes.
CREATE INDEX IF NOT EXISTS idx_disputes_request ON disputes (request_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status);
CREATE INDEX IF NOT EXISTS idx_disputes_payment ON disputes (payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_audit_settled
  ON payment_audit (payment_id) WHERE status = 'Settled';

CREATE INDEX IF NOT EXISTS idx_inventory_med ON inventory (medicine_id);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests (customer_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_reservations_request ON reservations (request_id);
CREATE INDEX IF NOT EXISTS idx_reservations_expiry ON reservations (status, lock_expires_at);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON ledger (request_id);
CREATE INDEX IF NOT EXISTS idx_lost_sales_medicine ON lost_sales (medicine_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_partner ON deliveries (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_location_delivery ON delivery_location (delivery_id);
CREATE INDEX IF NOT EXISTS idx_delivery_offers_delivery ON delivery_offers (delivery_id);

-- =============================================================
-- Migrations
--
-- Everything here must run AFTER every CREATE TABLE above, and every column
-- added after its table first shipped must be declared here rather than inline
-- in the CREATE TABLE. Two reasons, both learned the hard way:
--
--   1. `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has
--      the table, so an inline column addition never reaches a deployed
--      database and fails at runtime with "column does not exist".
--   2. An ALTER placed before its table is created breaks a fresh database.
--
-- All statements are idempotent, so this block is safe to re-run.
-- =============================================================
ALTER TABLE payment_audit ADD COLUMN IF NOT EXISTS metadata_json TEXT;

-- Seed data is inserted with explicit ids, so sequences must be realigned.
SELECT setval(pg_get_serial_sequence('pharmacies','id'), COALESCE((SELECT MAX(id) FROM pharmacies), 1));
SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 1));
SELECT setval(pg_get_serial_sequence('medicines','id'), COALESCE((SELECT MAX(id) FROM medicines), 1));
SELECT setval(pg_get_serial_sequence('requests','id'), COALESCE((SELECT MAX(id) FROM requests), 1));
SELECT setval(pg_get_serial_sequence('reservations','id'), COALESCE((SELECT MAX(id) FROM reservations), 1));
SELECT setval(pg_get_serial_sequence('ledger','id'), COALESCE((SELECT MAX(id) FROM ledger), 1));
SELECT setval(pg_get_serial_sequence('lost_sales','id'), COALESCE((SELECT MAX(id) FROM lost_sales), 1));
SELECT setval(pg_get_serial_sequence('demand_events','id'), COALESCE((SELECT MAX(id) FROM demand_events), 1));
SELECT setval(pg_get_serial_sequence('deliveries','id'), COALESCE((SELECT MAX(id) FROM deliveries), 1));
SELECT setval(pg_get_serial_sequence('delivery_offers','id'), COALESCE((SELECT MAX(id) FROM delivery_offers), 1));
SELECT setval(pg_get_serial_sequence('delivery_location','id'), COALESCE((SELECT MAX(id) FROM delivery_location), 1));
SELECT setval(pg_get_serial_sequence('audit_log','id'), COALESCE((SELECT MAX(id) FROM audit_log), 1));
SELECT setval(pg_get_serial_sequence('login_attempts','id'), COALESCE((SELECT MAX(id) FROM login_attempts), 1));
SELECT setval(pg_get_serial_sequence('recovery_codes','id'), COALESCE((SELECT MAX(id) FROM recovery_codes), 1));
SELECT setval(pg_get_serial_sequence('payments','id'), COALESCE((SELECT MAX(id) FROM payments), 1));
SELECT setval(pg_get_serial_sequence('payment_audit','id'), COALESCE((SELECT MAX(id) FROM payment_audit), 1));
SELECT setval(pg_get_serial_sequence('disputes','id'), COALESCE((SELECT MAX(id) FROM disputes), 1));