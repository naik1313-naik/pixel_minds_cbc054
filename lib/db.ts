import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { seedAll } from "./seed";
import { dataDir } from "./paths";

// Schema v2. Money is stored in integer paise. Timestamps are UTC ISO strings.
// Migrations are ordered and re-runnable (CREATE ... IF NOT EXISTS + guarded ALTERs).
const MIGRATIONS: { version: number; up: (db: Database.Database) => void }[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS pharmacies (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        drug_licence_no TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        response_score REAL NOT NULL DEFAULT 0.8,
        fulfilment_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        pharmacy_id INTEGER,
        totp_secret_enc TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        vehicle_number TEXT,
        id_type TEXT,
        id_last4 TEXT,
        partner_online INTEGER NOT NULL DEFAULT 0,
        partner_status TEXT,
        rating REAL NOT NULL DEFAULT 4.8,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
      );

      CREATE TABLE IF NOT EXISTS medicines (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        salt TEXT NOT NULL,
        price_paise INTEGER NOT NULL,
        rx_required INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS inventory (
        pharmacy_id INTEGER NOT NULL,
        medicine_id INTEGER NOT NULL,
        qty_total INTEGER NOT NULL DEFAULT 0,
        qty_locked INTEGER NOT NULL DEFAULT 0,
        expiry_date TEXT,
        PRIMARY KEY (pharmacy_id, medicine_id),
        CHECK (qty_locked >= 0 AND qty_locked <= qty_total),
        FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
        FOREIGN KEY (medicine_id) REFERENCES medicines(id)
      );

      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        medicine_id INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        secured_qty INTEGER NOT NULL DEFAULT 0,
        preferred_pharmacy_id INTEGER,
        fulfilment_type TEXT NOT NULL DEFAULT 'pickup',
        delivery_address TEXT,
        delivery_lat REAL,
        delivery_lng REAL,
        status TEXT NOT NULL,
        rx_verified INTEGER NOT NULL DEFAULT 0,
        rx_verified_by INTEGER,
        substitute_for_id INTEGER,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY (medicine_id) REFERENCES medicines(id)
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        pharmacy_id INTEGER NOT NULL,
        qty INTEGER NOT NULL,
        lock_expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'primary',
        created_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES requests(id)
      );

      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medicine_id INTEGER NOT NULL,
        pharmacy_id INTEGER,
        qty INTEGER NOT NULL,
        value INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS demand_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        medicine_id INTEGER NOT NULL,
        area TEXT,
        qty INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL UNIQUE,
        pharmacy_id INTEGER NOT NULL,
        partner_id INTEGER,
        status TEXT NOT NULL,
        destination_address TEXT NOT NULL,
        destination_lat REAL NOT NULL,
        destination_lng REAL NOT NULL,
        rx_required INTEGER NOT NULL DEFAULT 0,
        distance_km REAL,
        eta_minutes REAL,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id INTEGER NOT NULL,
        partner_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'offered',
        offered_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (delivery_id) REFERENCES deliveries(id)
      );

      CREATE TABLE IF NOT EXISTS delivery_location (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id INTEGER NOT NULL,
        partner_id INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        heading REAL,
        speed_mps REAL,
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
        ip TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        ip TEXT,
        success INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

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
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      // Document/ID verification: store the encrypted full ID number, its
      // masked display form, the automated verification outcome and metadata.
      const hasColumn = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
          (c) => c.name === column
        );
      const addColumn = (table: string, column: string, def: string) => {
        if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      };
      addColumn("users", "id_number_enc", "TEXT");
      addColumn("users", "doc_status", "TEXT");
      addColumn("users", "doc_checked_at", "TEXT");
      addColumn("users", "doc_meta_json", "TEXT");
      addColumn("pharmacies", "licence_verified", "TEXT");
      addColumn("pharmacies", "licence_checked_at", "TEXT");
      addColumn("pharmacies", "licence_meta_json", "TEXT");
    },
  },
];

declare global {
  // eslint-disable-next-line no-var
  var __medimeshDb: Database.Database | undefined;
}

function runMigrations(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version
    )
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString()
      );
    });
    tx();
  }
}

function createDb(): Database.Database {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "medimesh.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  const count = (db.prepare("SELECT COUNT(*) AS c FROM pharmacies").get() as { c: number }).c;
  if (count === 0) {
    const tx = db.transaction(() => seedAll(db));
    tx();
  }
  return db;
}

export function getDb(): Database.Database {
  if (!globalThis.__medimeshDb) globalThis.__medimeshDb = createDb();
  return globalThis.__medimeshDb;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

// Transactional full reset, used by the demo panel.
export function resetDemo(): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM delivery_location;
      DELETE FROM delivery_offers;
      DELETE FROM deliveries;
      DELETE FROM recovery_codes;
      DELETE FROM sessions;
      DELETE FROM audit_log;
      DELETE FROM login_attempts;
      DELETE FROM reservations;
      DELETE FROM requests;
      DELETE FROM ledger;
      DELETE FROM lost_sales;
      DELETE FROM demand_events;
      DELETE FROM inventory;
      DELETE FROM medicines;
      DELETE FROM users;
      DELETE FROM pharmacies;
      DELETE FROM settings;
      DELETE FROM sqlite_sequence;
    `);
    seedAll(db);
  });
  tx();
}

export function dbPath(): string {
  return path.join(dataDir(), "medimesh.db");
}
