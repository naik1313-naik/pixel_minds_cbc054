#!/usr/bin/env node
// Reset the PostgreSQL database so the next app start recreates and reseeds it.
// WARNING: destroys all runtime data (demo only).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { Pool } from "pg";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}

// Apply the schema and pre-resolve the lib/db singletons so resetDemo() can
// reseed without re-triggering getPool()'s seed-on-empty path.
async function boot() {
  const pool = new Pool({
    connectionString: connectionString(),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  const schemaPath = path.join(root, "lib", "schema.sql");
  if (fs.existsSync(schemaPath)) await pool.query(fs.readFileSync(schemaPath, "utf8"));
  globalThis.__medimeshPool = pool;
  globalThis.__medimeshSchemaReady = Promise.resolve(pool);
  globalThis.__medimeshSeeded = Promise.resolve();
  return pool;
}

async function main() {
  const pool = await boot();
  const { resetDemo } = require("jiti")(import.meta.url)(path.join(root, "lib", "db.ts"));
  // Suppress the demo-credentials banner (the file is still regenerated).
  process.env.MM_QUIET = "1";
  await resetDemo();
  console.log("Database reset and reseeded with demo data.");
  console.log("Start the app (npm run dev) if it is not already running.");
  await pool.end();
}

main().catch((err) => {
  console.error("db-reset failed:", err);
  process.exit(1);
});
