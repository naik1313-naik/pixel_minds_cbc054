#!/usr/bin/env node
// Inspect the MediMesh PostgreSQL database (verification columns included).
//
//   node scripts/db-inspect.mjs            # uses DATABASE_URL (or localhost/medimesh)
//   DATABASE_URL=postgresql://localhost/medimesh node scripts/db-inspect.mjs
//
// Read-only. Safe to run while the app is running.
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

// Apply the schema and pre-resolve the lib/db pool singleton so the read-only
// helpers below never take getPool()'s seed-on-empty path.
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

const line = (s = "") => console.log(s);

async function main() {
  const pool = await boot();
  const { queryAll } = require("jiti")(import.meta.url)(path.join(root, "lib", "db.ts"));

  line(`\nMediMesh database (PostgreSQL)`);
  line("=".repeat(60));

  const tables = await queryAll(
    `SELECT tablename AS name FROM pg_tables
      WHERE schemaname = current_schema() AND tablename NOT LIKE 'pg_%'
      ORDER BY tablename`
  );

  line("\nRow counts");
  line("-".repeat(60));
  for (const t of tables) {
    try {
      const rows = await queryAll(`SELECT COUNT(*)::int AS c FROM "${t.name}"`);
      line(`  ${t.name.padEnd(22)} ${rows[0].c}`);
    } catch {
      /* ignore */
    }
  }

  line("\nPharmacies (drug-licence verification)");
  line("-".repeat(60));
  const pharmacies = await queryAll(
    "SELECT id, name, drug_licence_no, verification_status, licence_verified FROM pharmacies ORDER BY id"
  );
  for (const p of pharmacies) {
    line(`  #${p.id} ${String(p.name).padEnd(26)} ${p.drug_licence_no.padEnd(18)} status=${p.verification_status} licence=${p.licence_verified ?? "unchecked"}`);
  }

  line("\nDelivery partners (ID verification)");
  line("-".repeat(60));
  const partners = await queryAll(
    "SELECT id, name, id_type, id_last4, doc_status, partner_status FROM users WHERE role = 'delivery_partner' ORDER BY id"
  );
  for (const u of partners) {
    line(`  #${u.id} ${String(u.name).padEnd(14)} ${String(u.id_type ?? "-").padEnd(8)} ****${u.id_last4 ?? "----"} doc=${u.doc_status ?? "unchecked"} partner=${u.partner_status ?? "-"}`);
  }

  line("");
  await pool.end();
}

main().catch((err) => {
  console.error("db-inspect failed:", err);
  process.exit(1);
});
