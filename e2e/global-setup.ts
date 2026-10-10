import { request } from "@playwright/test";

// Triggers first-run seeding (which writes data/.demo-credentials.txt) before tests.
export default async function globalSetup(config: { projects: { use: { baseURL?: string } }[] }) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3200";
  const ctx = await request.newContext();
  try {
    await ctx.get(`${baseURL}/api/medicines`, { timeout: 60_000 });
  } catch {
    /* server may still be compiling; tests will retry via UI */
  } finally {
    await ctx.dispose();
  }
}
