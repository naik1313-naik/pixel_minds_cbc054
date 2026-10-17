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

  // Re-map the on-chain wallets. A reset clears users.chain_wallet, so without
  // this every rider's settlement anchor fails with "no blockchain wallet is
  // mapped" — which looks like a broken feature rather than a reset side effect.
  const manifestPath = path.join(
    root,
    "blockchain",
    "deployments",
    process.env.MM_CHAIN_MANIFEST ?? "local.json"
  );
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const pharmacySlots = Object.entries(manifest.accounts?.pharmacies ?? {});
    const deliverySlots = Object.entries(manifest.accounts?.delivery ?? []);
    const pharmacies = (await pool.query("SELECT id FROM pharmacies ORDER BY id")).rows;
    const riders = (
      await pool.query("SELECT id FROM users WHERE role = 'delivery_partner' ORDER BY id")
    ).rows;
    for (const [i, row] of pharmacies.entries()) {
      if (pharmacySlots[i]) {
        await pool.query("UPDATE pharmacies SET wallet_address = $1 WHERE id = $2", [
          pharmacySlots[i][1],
          row.id,
        ]);
      }
    }
    for (const [i, row] of riders.entries()) {
      if (deliverySlots[i]) {
        await pool.query("UPDATE users SET chain_wallet = $1 WHERE id = $2", [
          deliverySlots[i][1],
          row.id,
        ]);
      }
    }
    console.log(
      `Mapped ${Math.min(pharmacies.length, pharmacySlots.length)} pharmacy and ` +
        `${Math.min(riders.length, deliverySlots.length)} rider wallets from the deployment manifest.`
    );
  } else {
    console.log("No deployment manifest found — on-chain anchors stay disabled. Run: npm run chain:deploy");
  }

  console.log("Start the app (npm run dev) if it is not already running.");
  await pool.end();
}

main().catch((err) => {
  console.error("db-reset failed:", err);
  process.exit(1);
});
