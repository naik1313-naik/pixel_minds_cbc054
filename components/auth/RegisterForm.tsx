"use client";

import { useState } from "react";
import Link from "next/link";
import { Alert, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/client";

type Role = "customer" | "pharmacy_owner" | "delivery_partner";

const LOCATIONS = [
  { name: "Indiranagar", lat: 12.9719, lng: 77.6412 },
  { name: "Koramangala", lat: 12.9352, lng: 77.6245 },
  { name: "Domlur", lat: 12.9609, lng: 77.6387 },
  { name: "Jayanagar", lat: 12.9308, lng: 77.5833 },
  { name: "Rajajinagar", lat: 12.9916, lng: 77.556 },
  { name: "Whitefield", lat: 12.9698, lng: 77.75 },
];

const ID_PLACEHOLDERS: Record<string, string> = {
  DL: "KA0120180001234",
  Aadhaar: "1234 5678 9012",
  Voter: "ABC1234567",
  Passport: "M1234567",
};

type DocResult = { status: string; valid: boolean; masked: string; type?: string; reference?: string | null; reasons: string[] };

export default function RegisterForm({ role }: { role: Role }) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirm: "",
    pharmacyName: "",
    address: "",
    licence: "",
    locationIdx: 0,
    vehicle: "",
    idType: "DL",
    idNumber: "",
  });
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ message: string; pending: boolean; doc?: DocResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [doc, setDoc] = useState<DocResult | null>(null);
  const [checking, setChecking] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function checkDocument() {
    setDoc(null);
    setError("");
    if (!form.idNumber.trim()) {
      setError("Enter your document number to verify");
      return;
    }
    setChecking(true);
    try {
      const res = await api.post<DocResult>("/api/identity/verify", {
        idType: form.idType,
        idNumber: form.idNumber,
        name: form.name || undefined,
      });
      setDoc(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setChecking(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      let body: Record<string, unknown> = {
        role,
        name: form.name,
        email: form.email,
        phone: form.phone || undefined,
        password: form.password,
      };
      if (role === "pharmacy_owner") {
        const loc = LOCATIONS[form.locationIdx];
        body = { ...body, pharmacyName: form.pharmacyName, address: form.address, licence: form.licence, lat: loc.lat, lng: loc.lng };
      }
      if (role === "delivery_partner") {
        body = { ...body, vehicle: form.vehicle, idType: form.idType, idNumber: form.idNumber };
      }
      const res = await api.post<{ message: string; pending: boolean; doc?: DocResult }>("/api/auth/register", body);
      setDone(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-md py-12">
        <Card className="p-8 text-center">
          <h1 className="text-xl font-bold text-slate-900">Almost there</h1>
          <p className="mt-3 text-sm text-slate-600">{done.message}</p>
          {done.doc && (
            <p className={`mt-2 text-sm font-medium ${done.doc.valid ? "text-teal-700" : "text-rose-600"}`}>
              {done.doc.valid ? "✓ Document verified" : "Document check failed"} · {done.doc.masked}
            </p>
          )}
          <Link href="/login" className="mt-6 inline-block font-semibold text-teal-700 hover:underline">
            Go to sign in
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-10">
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-slate-900">
          {role === "customer" ? "Create your account" : role === "pharmacy_owner" ? "Register your pharmacy" : "Become a delivery partner"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {role === "customer"
            ? "Find and reserve medicine across the network."
            : role === "pharmacy_owner"
            ? "Your pharmacy is verified by an administrator before it can operate."
            : "Your account is verified before you receive delivery jobs."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {error && <Alert><span>{error}</span></Alert>}
          <Input label="Full name" required value={form.name} onChange={set("name")} placeholder="Asha Rao" />
          <Input label="Email" type="email" required value={form.email} onChange={set("email")} placeholder="you@example.com" />
          <Input label="Phone" required={role !== "customer"} value={form.phone} onChange={set("phone")} placeholder="98xxxxxxxx" />

          {role === "pharmacy_owner" && (
            <div className="space-y-4 rounded-xl bg-slate-50 p-4">
              <Input label="Pharmacy name" required value={form.pharmacyName} onChange={set("pharmacyName")} placeholder="Green Cross Pharmacy" />
              <Input label="Address" required value={form.address} onChange={set("address")} placeholder="12, 100ft Road" />
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Location</span>
                <select
                  value={form.locationIdx}
                  onChange={(e) => setForm((f) => ({ ...f, locationIdx: Number(e.target.value) }))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                >
                  {LOCATIONS.map((l, i) => (
                    <option key={l.name} value={i}>{l.name}</option>
                  ))}
                </select>
              </label>
              <Input label="Drug licence number" required value={form.licence} onChange={set("licence")} placeholder="KA-BLR-20B-12345" />
              <p className="text-xs text-slate-500">We validate the format and checksum of your retail drug licence on submit.</p>
            </div>
          )}

          {role === "delivery_partner" && (
            <div className="space-y-4 rounded-xl bg-slate-50 p-4">
              <Input label="Vehicle number" required value={form.vehicle} onChange={set("vehicle")} placeholder="KA-01-AB-1234" />
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">ID type</span>
                <select
                  value={form.idType}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, idType: e.target.value }));
                    setDoc(null);
                  }}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                >
                  <option>DL</option>
                  <option>Aadhaar</option>
                  <option>Voter</option>
                  <option>Passport</option>
                </select>
              </label>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Input
                    label="ID number"
                    required
                    value={form.idNumber}
                    onChange={(e) => {
                      set("idNumber")(e);
                      setDoc(null);
                    }}
                    placeholder={ID_PLACEHOLDERS[form.idType] ?? ""}
                  />
                </div>
                <Button type="button" variant="subtle" loading={checking} onClick={checkDocument}>
                  Verify
                </Button>
              </div>
              {doc && (
                <div
                  className={`rounded-lg px-3 py-2 text-xs ${
                    doc.valid ? "bg-teal-50 text-teal-800" : "bg-rose-50 text-rose-700"
                  }`}
                >
                  {doc.valid ? `✓ Valid ${doc.type} · ${doc.masked}` : `✕ ${doc.reasons[0] ?? "Invalid document"}`}
                  {doc.valid && doc.reference ? <span className="block text-teal-600">Ref {doc.reference}</span> : null}
                </div>
              )}
              <p className="text-xs text-slate-500">
                Aadhaar numbers are checked with the Verhoeff checksum; PAN, DL, Voter and Passport formats are
                validated too. Your number is encrypted at rest and stored masked.
              </p>
            </div>
          )}

          <Input label="Password" type="password" required value={form.password} onChange={set("password")} placeholder="At least 12 characters, mixed case, number, symbol" />
          <Input label="Confirm password" type="password" required value={form.confirm} onChange={set("confirm")} placeholder="Re-enter password" />

          <Button type="submit" loading={loading} className="w-full">Create account</Button>
        </form>

        <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-slate-500">
          {role !== "customer" && <Link href="/register" className="text-teal-700 hover:underline">Customer sign-up</Link>}
          {role !== "pharmacy_owner" && <Link href="/pharmacy/register" className="text-teal-700 hover:underline">Register a pharmacy</Link>}
          {role !== "delivery_partner" && <Link href="/rider/register" className="text-teal-700 hover:underline">Join as a rider</Link>}
          <Link href="/login" className="text-teal-700 hover:underline">Sign in</Link>
        </div>
      </Card>
    </div>
  );
}
