import fs from "fs";
import os from "os";
import path from "path";

// Each test file runs in its own temp data dir with a fresh, seeded database.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "medimesh-test-"));
process.env.MM_DATA_DIR = dir;
process.env.MM_QUIET = "1";
process.env.DEMO_MODE = "1";
