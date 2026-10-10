#!/usr/bin/env node
// Delete the SQLite database so the next app start recreates and reseeds it.
// WARNING: destroys all runtime data (demo only).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.MM_DATA_DIR ? path.resolve(process.env.MM_DATA_DIR) : path.join(root, "data");

let removed = 0;
for (const suffix of ["", "-shm", "-wal", "-journal"]) {
  const f = path.join(dir, `medimesh.db${suffix}`);
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    removed++;
  }
}
console.log(removed ? `Removed ${removed} database file(s) from ${dir}.` : `No database files found in ${dir}.`);
console.log("Start the app (npm run dev) to create and seed a fresh database.");
