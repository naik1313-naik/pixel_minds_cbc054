#!/usr/bin/env node
// Resets the e2e database before the Playwright web server boots.
//
// Runs as part of the webServer command rather than in globalSetup, because
// Playwright starts the server *before* globalSetup: resetting afterwards would
// drop the schema underneath a live connection pool.
//
// Only ever touches a database whose name ends in _e2e, so a mistyped
// DATABASE_URL cannot wipe real data.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dsn = process.env.E2E_DATABASE_URL ?? "postgresql://localhost/medimesh_e2e";
const name = new URL(dsn).pathname.replace(/^\//, "");

if (!name.endsWith("_e2e")) {
  console.error(`Refusing to reset a database not named *_e2e: ${name}`);
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Seed here rather than letting the app do it on its first request. The app's
// seed-on-empty path only applies the schema, which left users without their
// on-chain wallet mapping and made every rider settlement anchor fail with "no
// blockchain wallet is mapped" during e2e runs.
const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "db-reset.mjs")],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: dsn, MM_QUIET: "1" },
  }
);

if (result.status !== 0) {
  console.error(`Failed to reset e2e database "${name}".`);
  process.exit(result.status ?? 1);
}
console.log(`Reset e2e database "${name}".`);