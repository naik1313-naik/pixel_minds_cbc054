/**
 * Demo-mode switch.
 *
 * One definition, imported everywhere, because "is this a demo?" decides whether
 * password/2FA can be bypassed, OTPs can be revealed and SMS can be printed. A
 * second copy of this rule anywhere else is a security bug waiting to happen.
 *
 * `NODE_ENV === "production"` is checked FIRST and wins over every env var.
 * That ordering is deliberate: `DEMO_MODE=1` must never be able to switch demo
 * affordances — least of all the one-click sign-in — on in a deployed
 * environment. The string comparison avoids TypeScript narrowing `NODE_ENV`
 * away at the call site.
 */
export function isDemoMode(): boolean {
  if (String(process.env.NODE_ENV ?? "") === "production") return false;
  const v = process.env.DEMO_MODE;
  return v === "1" || v === "true" || v == null || v === "";
}