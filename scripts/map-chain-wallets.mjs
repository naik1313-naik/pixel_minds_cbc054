/**
 * Maps on-chain wallets to the users they belong to.
 *
 * The deploy script authorizes Hardhat accounts and writes them into
 * `blockchain/deployments/local.json`, keyed by the account slot (pharmacies 1..8,
 * delivery actors 11..13). It has no idea what ids the database assigned to the
 * users, so the application could not answer "which wallet is this rider?" and
 * every rider's on-chain anchor failed with "no wallet mapped".
 *
 * This script is the bridge. It runs inside the application, which does have
 * the database, and writes the mapping into `users.chain_wallet`.
 *
 *   npm run chain:map-wallets
 *
 * Deterministic and repeatable: pharmacy ids and rider ids are matched to the
 * manifest's slots in id order, so re-running produces the same result.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// Same resolution order as lib/db.ts, so this script talks to the database the
// application talks to rather than a guessed one.
function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}

async function main() {
  const manifestPath = path.join(
    process.cwd(),
    "blockchain",
    "deployments",
    process.env.MM_CHAIN_MANIFEST ?? "local.json"
  );
  if (!fs.existsSync(manifestPath)) {
    console.error(`No deployment manifest at ${manifestPath}. Run: npm run chain:deploy`);
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const client = new Client({
    connectionString: connectionString(),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  const pharmacies = await client.query(
    "SELECT id FROM pharmacies ORDER BY id"
  );
  const riders = await client.query(
    "SELECT id FROM users WHERE role = 'delivery_partner' ORDER BY id"
  );

  const pharmacySlots = Object.entries(manifest.accounts?.pharmacies ?? {});
  const deliverySlots = Object.entries(manifest.accounts?.delivery ?? {});

  let mapped = 0;
  let unmapped = 0;

  for (const [index, row] of pharmacies.rows.entries()) {
    const slot = pharmacySlots[index];
    if (!slot) {
      console.warn(`  pharmacy ${row.id}: no wallet slot left in the manifest`);
      unmapped++;
      continue;
    }
    await client.query("UPDATE pharmacies SET wallet_address = $1 WHERE id = $2", [
      slot[1],
      row.id,
    ]);
    mapped++;
  }

  for (const [index, row] of riders.rows.entries()) {
    const slot = deliverySlots[index];
    if (!slot) {
      console.warn(`  rider ${row.id}: no wallet slot left in the manifest`);
      unmapped++;
      continue;
    }
    await client.query("UPDATE users SET chain_wallet = $1 WHERE id = $2", [slot[1], row.id]);
    mapped++;
  }

  await client.end();
  console.log(`Mapped ${mapped} wallet(s) to users (${unmapped} left unmapped).`);
  if (unmapped > 0) {
    console.log(
      "Some users have no wallet. That is not fatal — their writes are skipped and the " +
        "audit layer records the shortfall rather than inventing an address."
    );
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});