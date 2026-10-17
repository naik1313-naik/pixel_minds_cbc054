import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    // The reset runs before `next dev`, because Playwright starts the server
    // before globalSetup — resetting afterwards would drop the schema underneath
    // a live connection pool.
    //
    // The reset seeds into .e2e-data itself, so the directory must not be
    // deleted afterwards: doing so threw away the freshly written demo
    // credentials and every signed-in test failed with "credentials file
    // missing", which reads like an auth bug rather than a file-ordering one.
    command:
      "MM_DATA_DIR=.e2e-data node scripts/e2e-reset.mjs && DATABASE_URL=postgresql://localhost/medimesh_e2e DATABASE_SSL=false MM_DATA_DIR=.e2e-data DEMO_MODE=1 MM_QUIET=1 npx next dev -p " +
      PORT,
    url: BASE_URL,
    reuseExistingServer: false,
    // The reset now seeds the whole database before the server starts, so the
    // budget covers a full schema + seed pass as well as Next's first compile.
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
