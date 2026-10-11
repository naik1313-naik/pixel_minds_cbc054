// Ensures better-sqlite3 has a native binary matching the current Node runtime.
// On hosts that only ship prebuilt binaries for a different major version
// (e.g. some CI/serverless images) we rebuild from source.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function bindingPath() {
  try {
    const pkg = require.resolve("better-sqlite3/package.json");
    return path.join(path.dirname(pkg), "build", "Release", "better_sqlite3.node");
  } catch {
    return null;
  }
}

function works() {
  const p = bindingPath();
  if (!p || !existsSync(p)) return false;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a INT)");
    db.prepare("INSERT INTO t VALUES (?)").run(1);
    db.close();
    return true;
  } catch {
    return false;
  }
}

if (works()) {
  console.log("[sqlite] native binding OK");
  process.exit(0);
}

console.log("[sqlite] rebuilding native binding for node", process.version);
try {
  execFileSync("npm", ["rebuild", "better-sqlite3", "--build-from-source"], {
    stdio: "inherit",
  });
} catch {
  console.log("[sqlite] rebuild failed; falling back to prebuilt binary");
}

if (!works()) {
  console.error("[sqlite] better-sqlite3 native binding unusable in this environment");
  process.exit(0); // never hard-fail install; surfaces later as a runtime error
}