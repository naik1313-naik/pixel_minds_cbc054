import { request } from "@playwright/test";

// The e2e database is reset by scripts/e2e-reset.mjs, which runs as part of the
// webServer command — before the server boots. Doing it here instead would drop
// the schema underneath a live connection pool.
//
// This hook only waits for the server to be warm enough to have applied its
// schema and seeded the demo data the tests sign in with.
export default async function globalSetup(config: { projects: { use: { baseURL?: string } }[] }) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3200";
  const ctx = await request.newContext();
  try {
    // Two calls: the first applies the schema and seeds, the second covers the
    // case where the server was still compiling on the first.
    await ctx.get(`${baseURL}/api/medicines`, { timeout: 60_000 });
    await ctx.get(`${baseURL}/api/medicines`, { timeout: 60_000 });
  } catch {
    /* server may still be compiling; tests will retry via UI */
  } finally {
    await ctx.dispose();
  }
}