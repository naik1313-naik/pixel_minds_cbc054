import path from "path";
import fs from "fs";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { dataDir } from "./paths";

// PostgreSQL-backed data layer (Supabase-compatible).
// Uses the `pg` driver — Supabase exposes the same Postgres wire protocol via
// its pooled/unpooled connection strings, so only DATABASE_URL changes between
// local development and Supabase in production.

const SCHEMA_PATH = path.join(process.cwd(), "lib", "schema.sql");

// Arbitrary but fixed key for the cross-process DDL lock. Any constant works; it
// just has to be the same number in every process, and not collide with anything
// else that takes advisory locks in this database.
const SCHEMA_LOCK_KEY = 8_675_309;

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

  // Serialise DDL across every process that shares this database.
  //
  // Locally there is one process, so this never mattered. On a serverless host
  // each cold start runs this concurrently against the same database, and two
  // `CREATE TABLE IF NOT EXISTS` passes racing each other deadlock outright:
  //
  //   Process A waits for ShareLock on transaction B;
  //   process B waits for AccessExclusiveLock on pg_class;
  //   error: deadlock detected  (40P01)
  //
  // The failing request is whichever instance lost the race, so this showed up as
  // an intermittent 404 on a route that exists and works locally. A session
  // advisory lock makes one process apply the schema while the others wait, and
  // makes the losers no-ops rather than casualties.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
    try {
      await client.query(sql);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
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

/** The raw pool, for callers that need to hold a connection across queries. */
async function pool(): Promise<Pool> {
  return helperPool();
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

/**
 * Serialises resets inside this process.
 *
 * A test file that times out leaves its reset query running: the timeout aborts
 * the *awaiting*, not the statement on the server. The next `resetDemo()` then
 * races a half-applied delete against a fresh one, and the two interleave into
 * foreign-key violations and duplicate-key errors that look like real bugs.
 *
 * Chaining on a promise is enough here — it only has to stop two resets inside
 * one Node process from overlapping, which is the whole failure.
 */
let resetChain: Promise<void> = Promise.resolve();

export async function resetDemo(): Promise<void> {
  const run = resetChain.then(doReset, doReset);
  // Keep the chain alive after a failure, or one bad reset wedges every later one.
  resetChain = run.catch(() => undefined);
  return run;
}

// Delete order follows the foreign keys: every child row goes before its
// parent. Postgres enforces this immediately, so an out-of-order entry here
// fails the whole reset rather than half-clearing the database.
async function doReset(): Promise<void> {
  // One connection for BEGIN and COMMIT. Two calls on the pool can land on
  // different connections, and a transaction on a connection nobody commits is a
  // transaction that rolls back when it is released.
  const client = await (await pool()).connect();
  try {
    await client.query("BEGIN");
    await client.query(`
    -- Blockchain audit layer: children of deliveries / payments / batches.
    DELETE FROM delivery_audit;
    DELETE FROM payment_audit;
    DELETE FROM batch_transfers;
    DELETE FROM medicine_batches;
    DELETE FROM blockchain_operations;

    -- Delivery children.
    DELETE FROM delivery_location;
    DELETE FROM delivery_offers;
    DELETE FROM deliveries;

    -- Session and audit trails.
    DELETE FROM recovery_codes;
    DELETE FROM sessions;
    DELETE FROM audit_log;
    DELETE FROM login_attempts;

    -- Order children.
    DELETE FROM reservations;
    DELETE FROM disputes;
    DELETE FROM payments;
    DELETE FROM requests;

    -- Catalogue and inventory.
    DELETE FROM ledger;
    DELETE FROM lost_sales;
    DELETE FROM demand_events;
    DELETE FROM inventory;
    DELETE FROM medicines;

    -- People last: users reference pharmacies.
    DELETE FROM users;
    DELETE FROM pharmacies;
    DELETE FROM settings;
  `);
    await client.query("COMMIT");
  } catch (err) {
    // Without this the connection returns to the pool still holding an open
    // transaction, and every later query on it either joins that transaction or
    // blocks behind it.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const { seedDatabase } = await import("./seed");
  await seedDatabase();
}

export function dbPath(): string {
  return path.join(dataDir(), "medimesh.db");
}