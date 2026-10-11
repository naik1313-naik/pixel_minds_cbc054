import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { afterAll } from "vitest";
import { Pool } from "pg";

// Each test file runs in its own temp data dir with a fresh, seeded database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "medimesh-test-"));
process.env.MM_DATA_DIR = dir;
process.env.MM_QUIET = "1";
process.env.DEMO_MODE = "1";

function baseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}
function sslConfig() {
  return process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;
}

// Isolate every test file in its own Postgres schema. Test files run in
// parallel workers and each calls resetDemo(), so sharing one schema would let
// them wipe each other's data.
const schema = "mm_test_" + randomBytes(6).toString("hex");
const admin = new Pool({ connectionString: baseUrl(), ssl: sslConfig() });
await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
await admin.end();

const scoped = new URL(baseUrl());
scoped.searchParams.set("options", `-csearch_path=${schema}`);
process.env.DATABASE_URL = scoped.toString();

// Apply the schema and pre-resolve the lib/db pool singleton. Without this the
// first query triggers getPool()'s seed-on-empty path, which deadlocks because
// seedDatabase() calls back into getPool() while its promise is still pending.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslConfig() });
const schemaSql = fs.readFileSync(path.join(process.cwd(), "lib", "schema.sql"), "utf8");
await pool.query(schemaSql);

const g = globalThis as unknown as {
  __medimeshPool?: Pool;
  __medimeshReady?: Promise<Pool>;
};
g.__medimeshPool = pool;
g.__medimeshReady = Promise.resolve(pool);

afterAll(async () => {
  await pool.end();
  const cleaner = new Pool({ connectionString: baseUrl(), ssl: sslConfig() });
  await cleaner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await cleaner.end();
});
