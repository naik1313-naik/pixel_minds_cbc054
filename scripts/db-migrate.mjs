#!/usr/bin/env node
// Apply lib/schema.sql to the configured database.
//
//   node scripts/db-migrate.mjs
//   DATABASE_URL=postgresql://localhost/medimesh node scripts/db-migrate.mjs
//
// The app already applies the schema when it creates its connection pool, but
// that only happens on a cold start. Run this after pulling a change that adds
// a column or a table, so you do not have to restart the dev server to pick up
// the migration.
//
// The schema is written to be idempotent (IF NOT EXISTS everywhere), so this is
// safe to run repeatedly.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}

const pool = new Pool({
  connectionString: connectionString(),
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 2,
});

async function main() {
  const sql = fs.readFileSync(path.join(root, "lib", "schema.sql"), "utf8");
  await pool.query(sql);

  // Report the objects this run is responsible for, so a silent no-op on a
  // missing ALTER is visible rather than discovered mid-demo.
  const checks = [
    ["requests.amount_paise", "SELECT 1 FROM requests WHERE amount_paise IS NOT NULL LIMIT 1"],
    ["requests.payment_status", "SELECT 1 FROM requests WHERE payment_status IS NOT NULL LIMIT 1"],
    ["pharmacies.razorpay_account_id", "SELECT 1 FROM pharmacies WHERE razorpay_account_id IS NOT NULL LIMIT 1"],
    ["payments table", "SELECT 1 FROM payments LIMIT 1"],
    ["payment_audit table", "SELECT 1 FROM payment_audit LIMIT 1"],
    ["payment_audit.metadata_json", "SELECT 1 FROM payment_audit WHERE metadata_json IS NOT NULL LIMIT 1"],
  ];

  console.log("Schema applied.\n");
  for (const [label, probe] of checks) {
    try {
      await pool.query(probe);
      console.log(`  ok    ${label}`);
    } catch (e) {
      console.log(`  FAIL  ${label} — ${e.message}`);
      process.exitCode = 1;
    }
  }

  const { rows } = await pool.query(
    "SELECT (SELECT COUNT(*) FROM payments)::int AS payments, (SELECT COUNT(*) FROM payment_audit)::int AS settlements"
  );
  console.log(`\n${rows[0].payments} payment(s), ${rows[0].settlements} settlement record(s).`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());