"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  FlaskConical,
  ScrollText,
  Store,
  Truck,
  Users,
} from "lucide-react";
import { Badge, Button, Card, StatusPill, toast } from "@/components/ui";
import { api, formatRupees, timeAgo } from "@/lib/client";

interface Overview {
  counts: {
    users: number;
    pending_partners: number;
    pending_pharmacies: number;
    requests: number;
    active_requests: number;
    active_deliveries: number;
    active_sessions: number;
  };
  insights: {
    lowStock: { pharmacy_name: string; medicine_name: string; free: number }[];
    expiry: { pharmacy_name: string; medicine_name: string; expiry_date: string; qty_total: number }[];
    lostSales: { total_value: number; byMedicine: { medicine_name: string; qty: number; value: number }[] };
    ledger: { wholesale: number; fee: number };
    perPharmacy: { id: number; name: string; fulfilment_count: number; response_score: number; free_stock: number }[];
  };
  deliveries: { id: number; request_id: number; status: string; pharmacy_name: string | null; partner_name: string | null }[];
}
interface PharmacyRow {
  id: number;
  name: string;
  address: string;
  verification_status: string;
  fulfilment_count: number;
  drug_licence_no: string;
  licence_verified: string | null;
  licence_meta_json: string | null;
}
interface UserRow {
  id: number;
  name: string;
  email: string;
  role: string;
  partner_status: string | null;
  partner_online: number;
  id_type: string | null;
  id_last4: string | null;
  doc_status: string | null;
  doc: { masked?: string; reference?: string; reasons?: string[] } | null;
  created_at: string;
}
interface AuditRow {
  id: number;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
}

const TABS = [
  { key: "overview", label: "Overview", icon: <Activity className="h-4 w-4" /> },
  { key: "pharmacies", label: "Pharmacies", icon: <Store className="h-4 w-4" /> },
  { key: "partners", label: "Partners", icon: <Truck className="h-4 w-4" /> },
  { key: "users", label: "Users", icon: <Users className="h-4 w-4" /> },
  { key: "audit", label: "Audit log", icon: <ScrollText className="h-4 w-4" /> },
  { key: "demo", label: "Demo controls", icon: <FlaskConical className="h-4 w-4" /> },
] as const;

function docTone(status: string | null | undefined): "emerald" | "amber" | "rose" | "slate" {
  if (status === "verified") return "emerald";
  if (status === "pending" || !status) return "amber";
  return "rose";
}

function docMasked(metaJson: string | null): string | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson) as { masked?: string };
    return parsed.masked ?? null;
  } catch {
    return null;
  }
}

export default function AdminConsole() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pharmacies, setPharmacies] = useState<PharmacyRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [o, ph, us] = await Promise.all([
      api.get<Overview>("/api/admin/overview"),
      api.get<{ pharmacies: PharmacyRow[] }>("/api/admin/pharmacies"),
      api.get<{ users: UserRow[] }>("/api/admin/users"),
    ]);
    setOverview(o);
    setPharmacies(ph.pharmacies);
    setUsers(us.users);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "audit") {
      api.get<{ audit: AuditRow[] }>("/api/admin/audit?limit=150").then((r) => setAudit(r.audit)).catch(() => {});
    }
  }, [tab]);

  async function setPharmacyStatus(id: number, status: string) {
    setBusy(true);
    try {
      await api.put("/api/admin/pharmacies", { id, status });
      toast(`Pharmacy ${status}`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }
  async function setPartnerStatus(id: number, status: string) {
    setBusy(true);
    try {
      await api.put("/api/admin/partners", { id, status });
      toast(`Partner ${status}`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }
  async function demo(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      await api.post("/api/demo", { action, ...extra });
      if (action === "reset") {
        toast("Network reset — please sign in again", "info");
        setTimeout(() => window.location.assign("/login"), 1200);
        return;
      }
      toast(`Demo action: ${action}`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const partners = users.filter((u) => u.role === "delivery_partner");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Network administration</h1>
        <p className="text-sm text-slate-500">Verification, oversight and demo controls for the MediMesh network.</p>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && overview && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Users" value={overview.counts.users} />
            <Stat label="Total requests" value={overview.counts.requests} />
            <Stat label="Active requests" value={overview.counts.active_requests} tone="amber" />
            <Stat label="Active deliveries" value={overview.counts.active_deliveries} tone="teal" />
            <Stat label="Pending pharmacies" value={overview.counts.pending_pharmacies} tone="rose" />
            <Stat label="Pending partners" value={overview.counts.pending_partners} tone="rose" />
            <Stat label="Active sessions" value={overview.counts.active_sessions} />
            <Stat label="Lost sales" value={formatRupees(overview.insights.lostSales.total_value)} tone="rose" />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="flex items-center gap-2 font-semibold text-slate-900"><AlertTriangle className="h-4 w-4 text-amber-500" /> Low stock alerts</h2>
              <div className="mt-3 space-y-2">
                {overview.insights.lowStock.slice(0, 6).map((l, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-slate-700">{l.medicine_name} <span className="text-xs text-slate-400">· {l.pharmacy_name}</span></span>
                    <span className={l.free <= 1 ? "font-semibold text-rose-600" : "text-slate-500"}>{l.free} left</span>
                  </div>
                ))}
                {overview.insights.lowStock.length === 0 && <p className="text-sm text-slate-400">All stock healthy.</p>}
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Boxes className="h-4 w-4 text-rose-500" /> Expiring within 90 days</h2>
              <div className="mt-3 space-y-2">
                {overview.insights.expiry.slice(0, 6).map((l, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-slate-700">{l.medicine_name} <span className="text-xs text-slate-400">· {l.pharmacy_name}</span></span>
                    <span className="text-slate-500">{l.expiry_date} · {l.qty_total}</span>
                  </div>
                ))}
                {overview.insights.expiry.length === 0 && <p className="text-sm text-slate-400">Nothing expiring soon.</p>}
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="font-semibold text-slate-900">Inter-pharmacy ledger</h2>
              <div className="mt-3 flex gap-6 text-sm">
                <div><div className="text-xs uppercase text-slate-400">Wholesale moved</div><div className="text-lg font-bold text-slate-900">{formatRupees(overview.insights.ledger.wholesale)}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Platform fees</div><div className="text-lg font-bold text-slate-900">{formatRupees(overview.insights.ledger.fee)}</div></div>
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="font-semibold text-slate-900">Pharmacy performance</h2>
              <div className="mt-3 space-y-2">
                {overview.insights.perPharmacy.slice(0, 6).map((p) => (
                  <div key={p.id} className="flex justify-between text-sm">
                    <span className="text-slate-700">{p.name}</span>
                    <span className="text-slate-500">{p.fulfilment_count} fulfilled · score {p.response_score.toFixed(2)} · {p.free_stock} free</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === "pharmacies" && (
        <Card className="divide-y divide-slate-100">
          {pharmacies.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium text-slate-800">{p.name} <Badge tone={p.verification_status === "verified" ? "emerald" : p.verification_status === "pending" ? "amber" : "rose"}>{p.verification_status}</Badge> <Badge tone={docTone(p.licence_verified)}>licence {p.licence_verified ?? "unchecked"}</Badge></div>
                <div className="text-xs text-slate-500">{p.address} · {p.fulfilment_count} fulfilled</div>
                <div className="text-xs text-slate-400">Licence {docMasked(p.licence_meta_json) ?? p.drug_licence_no}</div>
              </div>
              {p.verification_status !== "verified" && (
                <div className="flex gap-2">
                  <Button loading={busy} onClick={() => setPharmacyStatus(p.id, "verified")}>Verify</Button>
                  <Button variant="danger" loading={busy} onClick={() => setPharmacyStatus(p.id, "rejected")}>Reject</Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {tab === "partners" && (
        <Card className="divide-y divide-slate-100">
          {partners.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium text-slate-800">
                  {p.name} <Badge tone={p.partner_status === "verified" ? "emerald" : p.partner_status === "pending" ? "amber" : "rose"}>{p.partner_status ?? "unknown"}</Badge>
                  {p.partner_online ? <Badge tone="teal">online</Badge> : null}
                  {p.id_type ? <Badge tone={docTone(p.doc_status)}>{p.id_type} · {p.doc_status ?? "unchecked"}</Badge> : null}
                </div>
                <div className="text-xs text-slate-500">{p.email}</div>
                {p.doc?.masked ? <div className="text-xs text-slate-400">ID {p.doc.masked}{p.doc.reference ? ` · ${p.doc.reference}` : ""}</div> : null}
              </div>
              {p.partner_status !== "verified" && (
                <div className="flex gap-2">
                  <Button loading={busy} onClick={() => setPartnerStatus(p.id, "verified")}>Verify</Button>
                  <Button variant="danger" loading={busy} onClick={() => setPartnerStatus(p.id, "rejected")}>Reject</Button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {tab === "users" && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
              <tr><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Role</th><th className="p-3">Joined</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="p-3 font-medium text-slate-800">{u.name}</td>
                  <td className="p-3 text-slate-500">{u.email}</td>
                  <td className="p-3"><Badge tone="slate">{u.role}</Badge></td>
                  <td className="p-3 text-xs text-slate-500">{timeAgo(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "audit" && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
              <tr><th className="p-3">When</th><th className="p-3">Actor</th><th className="p-3">Action</th><th className="p-3">Entity</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="p-3 whitespace-nowrap text-xs text-slate-500">{timeAgo(a.created_at)}</td>
                  <td className="p-3 text-slate-600">{a.actor_role ?? "system"}</td>
                  <td className="p-3 font-mono text-xs text-slate-800">{a.action}</td>
                  <td className="p-3 text-xs text-slate-500">{a.entity_type}{a.entity_id ? `#${a.entity_id}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "demo" && (
        <Card className="space-y-4 p-5">
          <h2 className="font-semibold text-slate-900">Demo controls</h2>
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" loading={busy} onClick={() => demo("reset")}>Reset network</Button>
            <Button variant="ghost" loading={busy} onClick={() => demo("lock20")}>20s reservation lock</Button>
            <Button variant="ghost" loading={busy} onClick={() => demo("lock30")}>30min reservation lock</Button>
            <Button variant="ghost" loading={busy} onClick={() => demo("outbreak", { medicineId: 1 })}>Simulate outbreak (Paracetamol)</Button>
          </div>
          <p className="text-xs text-slate-500">
            Reset wipes all requests, deliveries and sessions, then reseeds demo data. You will be signed out.
          </p>
          {overview && overview.deliveries.length > 0 && (
            <div className="space-y-2 pt-2">
              <h3 className="text-sm font-semibold text-slate-700">Advance a delivery (demo)</h3>
              {overview.deliveries.slice(0, 5).map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                  <span className="text-sm text-slate-600">#{d.id} · {d.pharmacy_name ?? "—"} · {d.partner_name ?? "unassigned"}</span>
                  <div className="flex items-center gap-2">
                    <StatusPill status={d.status} />
                    <Button variant="subtle" loading={busy} onClick={() => demo("step", { deliveryId: d.id })}>Step</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "slate" }: { label: string; value: number | string; tone?: "slate" | "amber" | "teal" | "rose" }) {
  const tones = {
    slate: "text-slate-900",
    amber: "text-amber-600",
    teal: "text-teal-600",
    rose: "text-rose-600",
  }[tone];
  return (
    <Card className="p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tones}`}>{value}</div>
    </Card>
  );
}
