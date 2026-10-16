/**
 * Demo accounts for a live walkthrough.
 *
 * Every seeded demo user has 2FA enabled, which makes a projection painful:
 * the operator has to read a TOTP code off another screen while a judge
 * watches. These entries sign in as the seeded demo personas with one tap.
 *
 * The safety rules are deliberately narrow, because this bypasses both the
 * password and the second factor:
 *
 *   1. Refused outright when NODE_ENV is "production" — not overridable by env.
 *   2. Only accounts whose email ends in `@medimesh.demo` can be used, i.e. the
 *      seeded fixtures. A real registered user can never be impersonated, even
 *      in demo mode.
 *   3. Every bypass is written to the audit log as `auth.demo_login`, so the
 *      log does not quietly become a lie.
 */
import { queryAll, queryOne } from "./db";
import type { DbUser } from "./auth";

export interface DemoAccount {
  key: string;
  email: string;
  role: string;
  label: string;
  blurb: string;
  group: "Customer" | "Pharmacy" | "Delivery" | "Admin";
}

/**
 * The curated set worth putting in front of an audience. Keys are stable ids,
 * not emails, so the buttons survive a reseed.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: "customer",
    email: "customer1@medimesh.demo",
    role: "customer",
    label: "Asha (customer)",
    blurb: "Places the order and pays",
    group: "Customer",
  },
  {
    key: "customer2",
    email: "customer2@medimesh.demo",
    role: "customer",
    label: "Ravi (customer)",
    blurb: "Second patient, for stock-split demos",
    group: "Customer",
  },
  {
    key: "owner1",
    email: "owner1@medimesh.demo",
    role: "pharmacy_owner",
    label: "Apollo Pharmacy",
    blurb: "Confirms, fulfils, sees payouts",
    group: "Pharmacy",
  },
  {
    key: "owner2",
    email: "owner2@medimesh.demo",
    role: "pharmacy_owner",
    label: "MedPlus",
    blurb: "Second pharmacy, for sourcing demos",
    group: "Pharmacy",
  },
  {
    key: "staff1",
    email: "staff1@medimesh.demo",
    role: "pharmacy_staff",
    label: "Apollo staff",
    blurb: "Staff view of the same pharmacy",
    group: "Pharmacy",
  },
  {
    key: "rider1",
    email: "rider1@medimesh.demo",
    role: "delivery_partner",
    label: "Kiran (rider)",
    blurb: "Online, takes deliveries",
    group: "Delivery",
  },
  {
    key: "rider2",
    email: "rider2@medimesh.demo",
    role: "delivery_partner",
    label: "Sana (rider)",
    blurb: "Second online rider",
    group: "Delivery",
  },
  {
    key: "admin",
    email: "admin@medimesh.demo",
    role: "admin",
    label: "Demo Admin",
    blurb: "Network view, verification, demo reset",
    group: "Admin",
  },
] as const;

/** Every seeded fixture uses this domain; nothing else is eligible for bypass. */
const DEMO_EMAIL_DOMAIN = "@medimesh.demo";

export function isDemoEmail(email: string): boolean {
  return email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);
}

/**
 * Resolves a demo key to its seeded user, enforcing the domain rule.
 *
 * Throws for an unknown key or a non-demo email rather than returning null, so
 * a caller cannot accidentally treat "refused" as "signed in".
 */
export async function findDemoUser(key: string): Promise<DbUser> {
  const account = DEMO_ACCOUNTS.find((a) => a.key === key);
  if (!account) throw new DemoLoginError("Unknown demo account", 404);
  if (!isDemoEmail(account.email)) throw new DemoLoginError("Refused", 403);

  // Re-check the domain against the database rather than trusting the table
  // above, so a hand-edited fixture still cannot be used to bypass auth.
  const user = await queryOne<DbUser & { email: string }>(
    "SELECT * FROM users WHERE email = $1",
    [account.email]
  );
  if (!user) throw new DemoLoginError("Demo data is not seeded yet", 404);
  if (!isDemoEmail(user.email)) throw new DemoLoginError("Refused", 403);
  return user;
}

export class DemoLoginError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DemoLoginError";
    this.status = status;
  }
}

/**
 * Demo accounts that actually exist right now.
 *
 * Listing only what resolves means a partially seeded database produces a
 * smaller (honest) button set instead of buttons that fail on click.
 */
export async function listAvailableDemoAccounts(): Promise<DemoAccount[]> {
  const emails = DEMO_ACCOUNTS.map((a) => a.email);
  const rows = await queryAll<{ email: string }>(
    "SELECT email FROM users WHERE email = ANY($1::text[])",
    [emails]
  );
  const present = new Set(rows.map((r) => r.email.toLowerCase()));
  return DEMO_ACCOUNTS.filter((a) => present.has(a.email.toLowerCase()));
}