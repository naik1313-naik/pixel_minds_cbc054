// Dev-only helper: sets a known password for demo accounts so the blockchain
// smoke test can sign in. Uses the app's own hashing. Not part of the app.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import { Pool } from "pg";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://localhost/medimesh",
});
const { hashPasswordSync } = require("jiti")(import.meta.url)(path.join(root, "lib", "password.ts"));

const PASSWORD = "SmokeTest!Passw0rd2026";
const emails = [
  "owner1@medimesh.demo",
  "owner2@medimesh.demo",
  "customer1@medimesh.demo",
  "rider1@medimesh.demo",
  "rider2@medimesh.demo",
  "rider3@medimesh.demo",
  "rider4@medimesh.demo",
];

const hash = hashPasswordSync(PASSWORD);
for (const email of emails) {
  await pool.query(
    "UPDATE users SET password_hash = $1, totp_enabled = 0, failed_attempts = 0, locked_until = NULL WHERE email = $2",
    [hash, email]
  );
}
// Clear the per-IP login throttle so repeated smoke runs can sign in.
const cleared = await pool.query("DELETE FROM login_attempts");

console.log(
  `Reset password for ${emails.length} demo accounts: ${PASSWORD} (cleared ${cleared.rowCount} login attempts)`
);
await pool.end();
