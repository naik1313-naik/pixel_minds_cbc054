#!/usr/bin/env node
// Resets the e2e database before the Playwright web server boots.
//
// Runs as part of the webServer command rather than in globalSetup, because
// Playwright starts the server *before* globalSetup: resetting afterwards would
// drop the schema underneath a live connection pool.
//
// Only ever touches a database whose name ends in _e2e, so a mistyped
// DATABASE_URL cannot wipe real data.
import { Client } from "pg";

const dsn = process.env.E2E_DATABASE_URL ?? "postgresql://localhost/medimesh_e2e";
const name = new URL(dsn).pathname.replace(/^\//, "");

if (!name.endsWith("_e2e")) {
  console.error(`Refusing to reset a database not named *_e2e: ${name}`);
  process.exit(1);
}

const client = new Client({ connectionString: dsn });
await client.connect();
try {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log(`Reset e2e database "${name}" — the app will reseed on first request.`);
} finally {
  await client.end();
}