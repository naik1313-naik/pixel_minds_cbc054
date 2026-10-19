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

/**
 * Whether one-tap sign-in is allowed on a public deployment.
 *
 * Deliberately separate from `isDemoMode`, because setting `DEMO_MODE` in
 * production to switch on one-click sign-in would also switch on every *other*
 * demo affordance: revealed OTPs, SMS printed to the server log, skipped 2FA.
 * Those are not needed to demo the product and none of them should be one env
 * var away from being public.
 *
 * So the opt-in is narrow and explicit:
 *
 *   - off unless `MM_DEMO_LOGIN_PROD` is set to 1/true;
 *   - refuses to arm when `MM_ALLOW_DEMO_LOGIN_IN_PROD` is not the exact
 *     acknowledgement string, so a stray env var cannot silently expose every
 *     seeded account on a public URL;
 *   - still only ever signs in a seeded @medimesh.demo persona, never a real
 *     account, and every use is written to the audit log.
 *
 * A production deployment with this on is a public demo. That is a real choice
 * with a real cost, so it is recorded in the audit log on every use rather than
 * left implicit in a config file.
 */
export function isDemoLoginAllowedInProd(): boolean {
  if (!isDemoMode()) {
    const armed = process.env.MM_DEMO_LOGIN_PROD === "1" || process.env.MM_DEMO_LOGIN_PROD === "true";
    if (!armed) return false;
    return process.env.MM_ALLOW_DEMO_LOGIN_IN_PROD === "I_UNDERSTAND_THIS_IS_PUBLIC";
  }
  return true;
}