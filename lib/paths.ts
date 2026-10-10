import path from "path";

// Runtime data directory. Overridable so tests can run against a temp dir.
export function dataDir(): string {
  return process.env.MM_DATA_DIR
    ? path.resolve(process.env.MM_DATA_DIR)
    : path.join(process.cwd(), "data");
}
