#!/usr/bin/env node
/**
 * Imports medicine catalogue records from CSV or JSON.
 *
 *   npm run catalogue:import -- samples/catalogue-sample.csv            # dry run
 *   npm run catalogue:import -- samples/catalogue-sample.csv --apply    # write
 *   npm run catalogue:import -- samples/catalogue-sample.json --apply --source gov-open-data
 *
 * Dry run is the default. An import of a few thousand rows should be something
 * you read before you commit to it, not something that happens because you typed
 * a path.
 *
 * Flags:
 *   --apply             write the rows (without it, nothing is written)
 *   --batch <n>         rows per batch, capped at 1000        (default 200)
 *   --source <name>     override the `source` column on every row
 *   --source-ref <id>   override the `source_ref` column
 *   --file <url>        import from a URL instead of a path
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import jitiPkg from "jiti";

// jiti ships CommonJS, so the factory comes off the default export.
const createJiti = jitiPkg.createJiti ?? ((...a) => jitiPkg(...a));

const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    "postgresql://localhost/medimesh"
  );
}

async function loadModule(rel) {
  const jiti = createJiti(import.meta.url);
  return jiti(path.join(process.cwd(), rel));
}

async function main() {
  if (!fileArg) {
    console.error("Usage: npm run catalogue:import -- <file.csv|file.json> [--apply]");
    process.exit(1);
  }

  const { readRecords, importRecords } = await loadModule("lib/catalogue-import.ts");

  const fileUrl = value("file");
  let file = fileArg;
  if (fileUrl) {
    console.log(`Fetching ${fileUrl} …`);
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Could not fetch ${fileUrl}: HTTP ${res.status}`);
    const tmp = path.join(process.cwd(), ".tmp-catalogue-import.json");
    fs.writeFileSync(tmp, await res.text());
    file = tmp;
    console.log("Saved to a temporary file. This does not scrape: it fetches one published URL.");
  }

  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  const records = readRecords(file);

  // Global overrides applied before validation, so provenance cannot be lost by
  // forgetting a column in the spreadsheet.
  const source = value("source");
  const sourceRef = value("source-ref");
  if (source || sourceRef) {
    for (const r of records) {
      if (source) r.source = source;
      if (sourceRef) r.source_ref = sourceRef;
    }
  }

  const pool = new Pool({
    connectionString: connectionString(),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const result = await importRecords(records, {
      pool,
      file: path.basename(file),
      dryRun: !flag("apply"),
      batchSize: Number(value("batch", "200")),
    });

    console.log(`\nCatalogue import — ${result.file}`);
    console.log(`  mode       ${result.dryRun ? "DRY RUN (nothing written)" : "APPLY (writing)"}`);
    console.log(`  rows       ${result.total}`);
    console.log(`  would add  ${result.inserted}`);
    console.log(`  would update ${result.updated}`);
    console.log(`  skipped    ${result.skipped}`);
    console.log(`  failed     ${result.failed}`);

    if (result.errors.length) {
      const shown = result.errors.slice(0, 25);
      console.log(`\n  ${result.errors.length} warning(s)/error(s), first ${shown.length}:`);
      for (const e of shown) console.log(`    row ${e.row} [${e.field}] ${e.message}`);
      if (result.errors.length > shown.length) {
        console.log(`    … and ${result.errors.length - shown.length} more`);
      }
    }

    if (result.dryRun) {
      console.log("\n  Nothing was written. Re-run with --apply to commit these changes.");
    } else {
      console.log(`\n  Done. ${result.inserted} added, ${result.updated} updated.`);
    }
    process.exitCode = result.failed > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});