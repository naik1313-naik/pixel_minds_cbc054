"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pill, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { Alert, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/client";

const ROLE_HOME: Record<string, string> = {
  customer: "/app",
  pharmacy_owner: "/pharmacy",
  pharmacy_staff: "/pharmacy",
  delivery_partner: "/rider",
  admin: "/admin",
};

interface DemoAccount {
  key: string;
  email: string;
  role: string;
  label: string;
  blurb: string;
  group: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccount[]>([]);
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  // Demo personas are listed first and offered as the primary path; the
  // password form is secondary. On a production build this list is empty, so
  // the page degrades to a normal login with no demo UI at all.
  useEffect(() => {
    fetch("/api/auth/demo-login")
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((d: { accounts?: DemoAccount[] }) => setDemoAccounts(d.accounts ?? []))
      .catch(() => setDemoAccounts([]));
  }, []);

  const demoLogin = useCallback(
    async (key: string) => {
      setDemoBusy(key);
      setError("");
      try {
        const res = await api.post<{ role: string }>("/api/auth/demo-login", { key });
        router.push(ROLE_HOME[res.role] ?? "/app");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Demo sign-in failed");
        setDemoBusy(null);
      }
    },
    [router]
  );

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ requires2fa?: boolean; challenge?: string; role?: string }>(
        "/api/auth/login",
        { email, password }
      );
      if (res.requires2fa && res.challenge) {
        setChallenge(res.challenge);
        return;
      }
      router.push(ROLE_HOME[res.role ?? "customer"] ?? "/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function submit2fa(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.post<{ role: string }>("/api/auth/2fa", { challenge, code: code.trim() });
      router.push(ROLE_HOME[res.role] ?? "/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col justify-center py-12">
      <Card className="p-8">
        <div className="mb-6 flex items-center gap-2 text-teal-700">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-teal-600 text-white">
            <Pill className="h-4 w-4" />
          </span>
          <span className="font-bold text-slate-900">MediMesh</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Welcome back</h1>
        <p className="mt-1 text-sm text-slate-500">
          {challenge ? "Enter the 6-digit code from your authenticator app." : "Sign in to your account."}
        </p>

        <div className="mt-6 space-y-4">
          {error && <Alert><span>{error}</span></Alert>}

          {demoAccounts.length > 0 && !challenge ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
                <Sparkles className="h-3.5 w-3.5" /> Demo accounts — tap to sign in
              </div>
              <div className="grid grid-cols-2 gap-2">
                {demoAccounts.map((a) => (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => demoLogin(a.key)}
                    disabled={demoBusy !== null}
                    className="flex flex-col items-start gap-0.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-teal-400 hover:bg-teal-50/50 disabled:opacity-60"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                      <UserRound className="h-3.5 w-3.5 text-teal-600" />
                      {demoBusy === a.key ? "Signing in…" : a.label}
                    </span>
                    <span className="text-xs text-slate-500">{a.blurb}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
                onClick={() => setShowPasswordForm((v) => !v)}
              >
                {showPasswordForm ? "Hide" : "Sign in with email and password"} instead
              </button>
            </div>
          ) : null}

          {challenge ? (
            <form onSubmit={submit2fa} className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl bg-purple-50 p-3 text-sm text-purple-800">
                <ShieldCheck className="h-4 w-4" /> Two-factor authentication is enabled for this account.
              </div>
              <Input
                label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456 or a recovery code"
              />
              <Button type="submit" loading={loading} className="w-full">Verify & sign in</Button>
              <button
                type="button"
                className="w-full text-center text-xs text-slate-500 hover:text-slate-700"
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                  setError("");
                }}
              >
                Use a different account
              </button>
            </form>
          ) : showPasswordForm || demoAccounts.length === 0 ? (
            <form onSubmit={submitPassword} className="space-y-4">
              <Input
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@medimesh.demo"
              />
              <Input
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
              <Button type="submit" loading={loading} className="w-full">Sign in</Button>
            </form>
          ) : null}
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          New here?{" "}
          <Link href="/register" className="font-semibold text-teal-700 hover:underline">
            Create an account
          </Link>
        </p>
      </Card>
      <p className="mt-4 text-center text-xs text-slate-400">
        {demoAccounts.length > 0 ? (
          <>Demo sign-in is available in this build and is disabled in production.</>
        ) : (
          <>
            Demo credentials are printed to the server terminal on first run and saved to{" "}
            <code className="rounded bg-slate-100 px-1">data/.demo-credentials.txt</code>.
          </>
        )}
      </p>
    </div>
  );
}
