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

-- Idempotent column additions for later schema versions.
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_number_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_checked_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_meta_json TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_verified TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_checked_at TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS licence_meta_json TEXT;

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