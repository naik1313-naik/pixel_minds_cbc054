import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne } from "@/lib/db";
import { isDemoMode } from "@/lib/demo";
import { DEMO_ACCOUNTS, findDemoUser, isDemoEmail, listAvailableDemoAccounts, DemoLoginError } from "@/lib/demo-accounts";

describe("demo mode switch", () => {
  it("is on for any non-production run, whatever DEMO_MODE says", () => {
    expect(isDemoMode()).toBe(true);
  });

  it("is hard off in production even with DEMO_MODE=1", () => {
    // NODE_ENV is readonly in the type, so it is swapped via the env object.
    const env = process.env as Record<string, string | undefined>;
    const previous = env.NODE_ENV;
    const previousDemo = env.DEMO_MODE;
    env.NODE_ENV = "production";
    env.DEMO_MODE = "1";
    try {
      // This is the property that matters: the bypass cannot be switched on by
      // an env var in a deployed environment.
      expect(isDemoMode()).toBe(false);
    } finally {
      env.NODE_ENV = previous;
      env.DEMO_MODE = previousDemo;
    }
  });
});

describe("demo account eligibility", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("recognises only the seeded demo domain", () => {
    expect(isDemoEmail("owner1@medimesh.demo")).toBe(true);
    expect(isDemoEmail("someone@example.com")).toBe(false);
    expect(isDemoEmail("admin@medimesh.demo.evil.com")).toBe(false);
  });

  it("lists only accounts that actually exist", async () => {
    const accounts = await listAvailableDemoAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.map((a) => a.key)).toContain("customer");
    expect(accounts.map((a) => a.key)).toContain("admin");
    for (const a of accounts) expect(isDemoEmail(a.email)).toBe(true);
  });

  it("resolves a seeded persona to the right role", async () => {
    expect((await findDemoUser("customer")).role).toBe("customer");
    expect((await findDemoUser("owner1")).role).toBe("pharmacy_owner");
    expect((await findDemoUser("rider1")).role).toBe("delivery_partner");
    expect((await findDemoUser("admin")).role).toBe("admin");
  });

  it("gives pharmacy owners a pharmacy, so the payout tab is reachable", async () => {
    const owner = await findDemoUser("owner1");
    expect(owner.pharmacy_id).toBe(1);
  });

  it("refuses an unknown key instead of signing anyone in", async () => {
    await expect(findDemoUser("nope")).rejects.toBeInstanceOf(DemoLoginError);
  });

  it("cannot be pointed at a real, non-demo account", async () => {
    // A user registered through the app must be unreachable by the bypass even
    // though they sit in the same table.
    const { hashPasswordSync } = await import("@/lib/password");
    const { queryRun } = await import("@/lib/db");
    await queryRun(
      `INSERT INTO users (email, name, password_hash, role, created_at)
       VALUES ('real.person@example.com', 'Real Person', $1, 'admin', $2)`,
      [hashPasswordSync("a-very-long-password"), new Date().toISOString()]
    );

    // The curated table only lists seeded personas, so there is no key that
    // resolves to a non-demo user.
    const keys = DEMO_ACCOUNTS.map((a) => a.key);
    expect(keys).not.toContain("real");
    const real = await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE email = 'real.person@example.com'"
    );
    expect(real).toBeTruthy();
    // And every resolvable key lands on the demo domain.
    for (const key of keys) {
      const user = await findDemoUser(key);
      expect(isDemoEmail(user.email)).toBe(true);
    }
  });

  it("refuses a key whose persona is missing from the seed", async () => {
    const { queryRun } = await import("@/lib/db");
    await queryRun("DELETE FROM users WHERE email = 'customer2@medimesh.demo'");
    await expect(findDemoUser("customer2")).rejects.toThrow(/not seeded/i);
    // It also drops out of the button list rather than failing on click.
    const available = await listAvailableDemoAccounts();
    expect(available.map((a) => a.key)).not.toContain("customer2");
  });
});