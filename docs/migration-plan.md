# SQLite → Supabase (Postgres) migration plan

Status: **foundation complete, data-layer conversion pending.**

## Why

The app runs on SQLite (`better-sqlite3`), a synchronous, native C++ driver. That
makes it impossible to host on serverless platforms (Vercel / Cloudflare Workers):
the native binary either crashes (`SIGABRT`) or is unsupported. Supabase exposes
a hosted **PostgreSQL** database, which is reachable over the network from any
runtime and is async — the standard way to deploy a Next.js app on Vercel.

## What is already done (branch `supabase-migration`)

- `lib/schema.sql` — full PostgreSQL DDL, 17 tables, idempotent (`IF NOT EXISTS`),
  sequences realigned after the explicit-id seed. Verified against a local
  Postgres 16 instance.
- `lib/db.ts` — async data layer on the `pg` driver:
  - `getPool()`, `queryOne`, `queryAll`, `queryRun`, `queryReturning`, `queryRaw`
  - `withTransaction()` using real `BEGIN`/`COMMIT`/`ROLLBACK` (replaces
    `better-sqlite3`'s synchronous `db.transaction`).
  - Connection string from `DATABASE_URL` / `SUPABASE_DB_URL` / `POSTGRES_URL`,
    so only the env var changes between local Postgres and Supabase.
- `lib/seed.ts` — converted to async parameterized Postgres inserts.

## Remaining work (ordered, each step ends compiling)

Every remaining file uses the old synchronous `getDb().prepare(...).get()/.all()/
.run()` API and must be rewritten to the async helpers, plus all of its callers
must `await` it.

1. `lib/engine.ts` (28 exported fns) — matching, soft-lock, confirm/reject,
   borrow, split, expiry sweep.
2. `lib/delivery.ts` (26 exported fns) — offers, accept/approve/reject
   assignment, lifecycle transitions, location, OTP handover, sweeps.
3. `lib/auth.ts` (16 exported fns) — login, sessions, 2FA, `registerUser`.
4. `lib/session.ts`, `lib/access.ts`, `lib/audit.ts`.
5. 38 API route handlers under `app/api/**` — add `await`.
6. Tests (`tests/*.test.ts`) and `scripts/*.mjs` — await + async lifecycle.
7. `.env` for Supabase:
   - `DATABASE_URL` = Supabase **session pooler** URL (or direct connection).
   - `DATABASE_SSL=true` (already handled in `lib/db.ts`).
   - `APP_ENCRYPTION_KEY`, `SESSION_PEPPER` — production secrets.
8. Seed + migrate existing demo data, then run the full gate suite.

## Transaction semantics (important)

`better-sqlite3` transactions are synchronous and atomic. The Postgres layer uses
`withTransaction` with a dedicated client. The business-critical atomic sections
that MUST be ported carefully (they prevent overselling and double-assignment):

- `lib/engine.ts` — atomic soft-lock
  (`UPDATE ... WHERE qty_total - qty_locked >= :qty`).
- `lib/delivery.ts` — single-winner `acceptOffer`, `approveAssignment`,
  `rejectAssignment`, OTP verification + `finalizeDeliveredRequest`.

Keep the conditional-UPDATE guard (row-count check) inside the transaction; do
not "simplify" it into read-then-write.

## Testing locally (no Supabase keys needed)

Supabase is just Postgres, so the whole suite can be exercised against a local
instance:

```bash
createdb medimesh
DATABASE_URL=postgresql://localhost/medimesh npm test
DATABASE_URL=postgresql://localhost/medimesh npm run acceptance
```

When the conversion is complete, switch only `DATABASE_URL` to the Supabase
connection string to deploy on Vercel.