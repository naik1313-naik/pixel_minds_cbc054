#!/usr/bin/env node
// Inspect the MediMesh SQLite database (verification columns included).
//
//   node scripts/db-inspect.mjs            # uses ./data/medimesh.db
//   MM_DATA_DIR=/tmp/x node scripts/db-inspect.mjs
//
// Read-only. Safe to run while the app is running.
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.MM_DATA_DIR ? path.resolve(process.env.MM_DATA_DIR) : path.join(root, "data");
const file = path.join(dir, "medimesh.db");

if (!fs.existsSync(file)) {
  console.error(`No database at ${file}. Start the app (npm run dev) to create and seed it.`);
  process.exit(1);
}

const db = new Database(file, { readonly: true });
const line = (s = "") => console.log(s);

line(`\nMediMesh database: ${file}`);
line("=".repeat(60));

const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
line(`Migrations applied: ${applied.map((r) => r.version).join(", ") || "(none)"}`);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

line("\nRow counts");
line("-".repeat(60));
for (const t of tables) {
  try {
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get();
    line(`  ${t.padEnd(22)} ${c}`);
  } catch {
    /* ignore */
  }
}

line("\nPharmacies (drug-licence verification)");
line("-".repeat(60));
for (const p of db
  .prepare("SELECT id, name, drug_licence_no, verification_status, licence_verified FROM pharmacies ORDER BY id")
  .all()) {
  line(`  #${p.id} ${String(p.name).padEnd(26)} ${p.drug_licence_no.padEnd(18)} status=${p.verification_status} licence=${p.licence_verified ?? "unchecked"}`);
}

line("\nDelivery partners (ID verification)");
line("-".repeat(60));
for (const u of db
  .prepare(
    "SELECT id, name, id_type, id_last4, doc_status, partner_status FROM users WHERE role = 'delivery_partner' ORDER BY id"
  )
  .all()) {
  line(`  #${u.id} ${String(u.name).padEnd(14)} ${String(u.id_type ?? "-").padEnd(8)} ****${u.id_last4 ?? "----"} doc=${u.doc_status ?? "unchecked"} partner=${u.partner_status ?? "-"}`);
}

db.close();
line("");
