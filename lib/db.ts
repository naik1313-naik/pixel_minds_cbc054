import path from "path";
import fs from "fs";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { dataDir } from "./paths";

// PostgreSQL-backed data layer (Supabase-compatible).
// Uses the `pg` driver — Supabase exposes the same Postgres wire protocol via
// its pooled/unpooled connection strings, so only DATABASE_URL changes between
// local development and Supabase in production.

const SCHEMA_PATH = path.join(process.cwd(), "lib", "schema.sql");

declare global {
  // eslint-disable-next-line no-var
  var __medimeshPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __medimeshSchemaReady: Promise<Pool> | undefined;
  // eslint-disable-next-line no-var
  var __medimeshSeeded: Promise<void> | undefined;
  // When set, query helpers use this pool directly (used only during seeding so
  // seed inserts do not re-enter getPool and deadlock on the seeding promise).
  // eslint-disable-next-line no-var
  var __medimeshLocalPool: Pool | undefined;
}

function connectionString(): string {
  const url =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    // Local dev fallback (Homebrew Postgres default trust auth).
    "postgresql://localhost/medimesh";
  return url;
}

function createPool(): Pool {
  return new Pool({
    connectionString: connectionString(),
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase (serverless driver) needs TLS; local dev over TCP does not.
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
}

async function applySchema(pool: Pool): Promise<void> {
  let sql: string;
  if (fs.existsSync(SCHEMA_PATH)) {
    sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  } else {
    // Bundled deployments may not ship the file; rely on pre-applied schema.
    return;
  }
  await pool.query(sql);
}

// Ensures the pool exists and the schema has been applied, WITHOUT seeding.
// Query helpers use this (not getPool) so that seeding — which itself runs
// queries through these helpers — cannot deadlock on the seeding promise.
async function basePool(): Promise<Pool> {
  if (!globalThis.__medimeshPool) globalThis.__medimeshPool = createPool();
  const pool = globalThis.__medimeshPool;
  if (!globalThis.__medimeshSchemaReady) {
    globalThis.__medimeshSchemaReady = applySchema(pool).then(() => pool);
  }
  await globalThis.__medimeshSchemaReady;
  return pool;
}

// Returns a ready pool, seeding the database once if it is empty. During the
// seed pass, query helpers are pointed at the raw pool via __medimeshLocalPool
// so seed inserts do not recursively await this promise (deadlock).
export async function getPool(): Promise<Pool> {
  const pool = await basePool();
  if (!globalThis.__medimeshSeeded) {
    globalThis.__medimeshSeeded = (async () => {
      globalThis.__medimeshLocalPool = pool;
      try {
        const count = await pool.query<{ c: number }>("SELECT COUNT(*)::int AS c FROM pharmacies");
        if (count.rows[0].c === 0) {
          // Seeding is intentionally deferred to lib/seed (imported lazily to
          // avoid a circular dependency at module init).
          const { seedDatabase } = await import("./seed");
          await seedDatabase();
        }
      } finally {
        globalThis.__medimeshLocalPool = undefined;
      }
    })();
  }
  await globalThis.__medimeshSeeded;
  return pool;
}

// Pool used by the query helpers. Normally routes through getPool(); while a
// seed pass is running it returns the raw pool to avoid re-entrant deadlock.
async function helperPool(): Promise<Pool> {
  if (globalThis.__medimeshLocalPool) return globalThis.__medimeshLocalPool;
  return getPool();
}

// Run a parameterized query and return the first row (or undefined).
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const pool = await helperPool();
  const res = await pool.query<T>(text, params as never[]);
  return res.rows[0];
}

// Run a parameterized query and return all rows.
export async function queryAll<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = await helperPool();
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

// Run a parameterized write and return the affected row count.
export async function queryRun(text: string, params: unknown[] = []): Promise<number> {
  const pool = await helperPool();
  const res = await pool.query(text, params as never[]);
  return res.rowCount ?? 0;
}

// Run an INSERT ... RETURNING <col> and return the value of that column.
export async function queryReturning<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const pool = await helperPool();
  const res = await pool.query<T>(text, params as never[]);
  return res.rows[0];
}

// Execute raw multi-statement SQL (schema, bulk resets).
export async function queryRaw(sql: string): Promise<void> {
  const pool = await helperPool();
  await pool.query(sql);
}

// Run a function inside a real database transaction. The callback receives a
// client; all mutations commit atomically or roll back together.
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>
): Promise<T> {
  const pool = await helperPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(new TxClient(client));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be gone */
    }
    throw e;
  } finally {
    client.release();
  }
}

// Small async wrapper over a transaction client mirroring the helpers above,
// so transactional code reads naturally.
export class TxClient {
  constructor(private client: PoolClient) {}

  async one<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.client.query<T>(text, params as never[]);
    return res.rows[0];
  }

  async all<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query<T>(text, params as never[]);
    return res.rows;
  }

  async run(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(text, params as never[]);
    return res.rowCount ?? 0;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await queryRun(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// Transactional full reset, used by the demo panel.
export async function resetDemo(): Promise<void> {
  await queryRaw(`
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
  `);
  const { seedDatabase } = await import("./seed");
  await seedDatabase();
}

export function dbPath(): string {
  return path.join(dataDir(), "medimesh.db");
}