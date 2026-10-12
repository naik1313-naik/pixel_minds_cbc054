"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Clock, MapPin, Navigation, Package, Pill, Search, Store, Truck } from "lucide-react";
import { Alert, Badge, Button, Card, Input, StatusPill, toast } from "@/components/ui";
import { api, formatRupees, timeAgo } from "@/lib/client";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface Medicine {
  id: number;
  name: string;
  salt: string;
  price_paise: number;
  rx_required: number;
  total_free: number;
}
interface PharmacyStock {
  pharmacy_id: number;
  pharmacy_name: string;
  pharmacy_verification: string;
  free: number;
  distance_km: number;
  score: number;
  expiry_date: string | null;
  lat: number;
  lng: number;
}
interface Substitute {
  medicine: Medicine;
  total_free: number;
}
interface Detail {
  medicine: Medicine;
  total_free: number;
  pharmacies: PharmacyStock[];
  substitutes: Substitute[];
  competing: { recent_demand: number; active_requests: number; total_free: number };
}
interface RequestRow {
  id: number;
  medicine_name: string;
  qty: number;
  secured_qty: number;
  status: string;
  fulfilment_type: string;
  created_at: string;
  pharmacy_name: string | null;
}
interface PharmacyOption {
  id: number;
  name: string;
  address: string;
  verification_status: string;
}

export default function CustomerApp({ customerName }: { customerName: string }) {
  const router = useRouter();
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [qty, setQty] = useState(1);
  const [type, setType] = useState<"pickup" | "delivery">("pickup");
  const [address, setAddress] = useState("12, 100ft Road, Indiranagar, Bengaluru");
  const [focusedPharmacy, setFocusedPharmacy] = useState<number | null>(null);
  const [pharmacies, setPharmacies] = useState<PharmacyOption[]>([]);
  const [chosenPharmacy, setChosenPharmacy] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Every verified pharmacy in the network, including ones registered after the
  // demo data was seeded, so a customer can always pick a specific store.
  useEffect(() => {
    api
      .get<{ pharmacies: PharmacyOption[] }>("/api/pharmacies")
      .then((r) => setPharmacies((r.pharmacies ?? []).filter((p) => p.verification_status === "verified")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.get<{ medicines: Medicine[] }>("/api/medicines").then((r) => setMedicines(r.medicines)).catch(() => {});
    refreshRequests();
  }, []);

  useEffect(() => {
    if (selected == null) return;
    setFocusedPharmacy(null);
    setChosenPharmacy("");
    api.get<Detail>(`/api/medicines/${selected}`).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  function refreshRequests() {
    api.get<{ requests: RequestRow[] }>("/api/requests").then((r) => setRequests(r.requests)).catch(() => {});
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return medicines;
    return medicines.filter((m) => m.name.toLowerCase().includes(q) || m.salt.toLowerCase().includes(q));
  }, [medicines, query]);

  async function createRequest() {
    if (selected == null) return;
    setBusy(true);
    setError("");
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await api.post<{ requestId: number }>(
        "/api/requests",
        {
          medicineId: selected,
          qty,
          fulfilmentType: type,
          preferredPharmacyId: chosenPharmacy === "" ? undefined : chosenPharmacy,
          deliveryAddress: type === "delivery" ? address : undefined,
          deliveryLat: type === "delivery" ? 12.9719 : undefined,
          deliveryLng: type === "delivery" ? 77.6412 : undefined,
        },
        { "idempotency-key": idempotencyKey }
      );
      toast("Request created", "success");
      router.push(`/app/request/${res.requestId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Hello, {customerName.split(" ")[0]}</h1>
        <p className="text-sm text-slate-500">Search a medicine to see live availability across the network.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or salt…"
              className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            />
          </div>
          <div className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
            {filtered.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelected(m.id)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition ${
                  selected === m.id ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50"
                }`}
              >
                <span>
                  <span className="flex items-center gap-2 font-medium text-slate-800">
                    {m.name}
                    {m.rx_required ? <Badge tone="rose">Rx</Badge> : null}
                  </span>
                  <span className="block text-xs text-slate-500">{m.salt} · {formatRupees(m.price_paise)}</span>
                </span>
                <span className={`text-sm font-semibold ${m.total_free > 0 ? "text-teal-700" : "text-rose-500"}`}>
                  {m.total_free > 0 ? `${m.total_free} available` : "Out of stock"}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">No medicines match.</p>}
          </div>
        </Card>

        <div className="space-y-4">
          {detail ? (
            <>
              <Card className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">{detail.medicine.name}</h2>
                    <p className="text-sm text-slate-500">{detail.medicine.salt} · {formatRupees(detail.medicine.price_paise)} per unit</p>
                  </div>
                  {detail.medicine.rx_required ? <Badge tone="rose">Prescription</Badge> : <Badge tone="teal">OTC</Badge>}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1"><Package className="h-3.5 w-3.5" /> {detail.total_free} units free</span>
                  <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {detail.competing.active_requests} active requests</span>
                </div>

                <div className="mt-4 overflow-hidden rounded-xl">
                  <MapView
                    className="h-[300px] w-full"
                    pharmacy={null}
                    destination={null}
                    rider={null}
                    track={[]}
                    pharmacies={detail.pharmacies
                      .filter((p) => typeof p.lat === "number" && typeof p.lng === "number")
                      .map((p) => ({
                        id: p.pharmacy_id,
                        name: p.pharmacy_name,
                        lat: p.lat,
                        lng: p.lng,
                        free: p.free,
                        distance_km: p.distance_km,
                        selected: focusedPharmacy === p.pharmacy_id,
                      }))}
                    onSelectPharmacy={(id) => setFocusedPharmacy((cur) => (cur === id ? null : id))}
                  />
                  <p className="mt-2 text-[11px] text-slate-400">
                    Demo network · {detail.pharmacies.length} pharmacies with this medicine · tap a pin to focus
                  </p>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Pharmacies stocking this
                    </p>
                    {chosenPharmacy !== "" && (
                      <button
                        type="button"
                        onClick={() => setChosenPharmacy("")}
                        className="text-xs text-teal-600 hover:underline"
                      >
                        Clear selection
                      </button>
                    )}
                  </div>
                  {detail.pharmacies.slice(0, 5).map((p) => (
                    <div
                      key={p.pharmacy_id}
                      className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 transition ${
                        chosenPharmacy === p.pharmacy_id
                          ? "border-teal-400 bg-teal-50/70 ring-1 ring-teal-200"
                          : "border-slate-100 hover:bg-slate-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setFocusedPharmacy((cur) => (cur === p.pharmacy_id ? null : p.pharmacy_id))}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                          <Store className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="truncate">{p.pharmacy_name}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">
                          {p.free} free · {p.distance_km} km
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setChosenPharmacy((cur) => (cur === p.pharmacy_id ? "" : p.pharmacy_id))
                        }
                      >
                        {chosenPharmacy === p.pharmacy_id ? "Selected" : "Request here"}
                      </Button>
                    </div>
                  ))}
                  {detail.pharmacies.length === 0 && <p className="text-sm text-rose-500">Currently unavailable anywhere in the network.</p>}
                </div>
              </Card>

              <Card className="p-5">
                <h3 className="font-semibold text-slate-900">Request this medicine</h3>
                {error && <div className="mt-3"><Alert><span>{error}</span></Alert></div>}
                <div className="mt-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Request from pharmacy
                    </span>
                    <select
                      value={chosenPharmacy}
                      onChange={(e) => setChosenPharmacy(e.target.value === "" ? "" : Number(e.target.value))}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    >
                      <option value="">Auto — let MediMesh pick the best nearby</option>
                      {pharmacies.map((p) => {
                        const stock = detail.pharmacies.find((s) => s.pharmacy_id === p.id);
                        return (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {stock ? ` · ${stock.free} in stock` : " · out of stock"}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    {chosenPharmacy === ""
                      ? "We route this to the highest-scoring pharmacy near you."
                      : `This request goes straight to ${pharmacies.find((p) => p.id === chosenPharmacy)?.name ?? "the selected pharmacy"}.`}
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Quantity</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={qty}
                      onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Fulfilment</span>
                    <select
                      value={type}
                      onChange={(e) => setType(e.target.value as "pickup" | "delivery")}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
                    >
                      <option value="pickup">Pickup at pharmacy</option>
                      <option value="delivery">Home delivery</option>
                    </select>
                  </label>
                </div>
                {type === "delivery" && (
                  <div className="mt-3">
                    <Input label="Delivery address" value={address} onChange={(e) => setAddress(e.target.value)} />
                  </div>
                )}
                <Button
                  className="mt-4 w-full"
                  loading={busy}
                  onClick={createRequest}
                  disabled={detail.total_free === 0 && chosenPharmacy === ""}
                >
                  <Truck className="h-4 w-4" /> Request {qty} × {detail.medicine.name}
                </Button>
                {detail.total_free === 0 && chosenPharmacy === "" && (
                  <p className="mt-2 text-xs text-slate-500">
                    Nothing is in stock across the network. Pick a specific pharmacy above to send them the
                    request anyway.
                  </p>
                )}
                {detail.substitutes.length > 0 && (
                  <p className="mt-3 text-xs text-slate-500">
                    Substitutes sharing the salt:{" "}
                    {detail.substitutes.map((s) => `${s.medicine.name} (${s.total_free})`).join(", ")}. Pharmacist approval required.
                  </p>
                )}
              </Card>
            </>
          ) : (
            <Card className="grid h-full min-h-[16rem] place-items-center p-6 text-center text-sm text-slate-400">
              <div>
                <Pill className="mx-auto mb-2 h-8 w-8 text-slate-300" />
                Select a medicine to see availability and reserve it.
              </div>
            </Card>
          )}
        </div>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">My requests</h2>
          <Button variant="ghost" onClick={refreshRequests}>Refresh</Button>
        </div>
        <div className="mt-3 divide-y divide-slate-100">
          {requests.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No requests yet.</p>}
          {requests.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(`/app/request/${r.id}`)}
              className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-slate-50"
            >
              <div>
                <div className="font-medium text-slate-800">
                  {r.qty} × {r.medicine_name}
                  {r.secured_qty < r.qty && r.secured_qty > 0 ? <span className="ml-2 text-xs text-orange-600">{r.secured_qty} secured</span> : null}
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {r.fulfilment_type === "delivery" ? <Navigation className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}
                  {r.fulfilment_type} · {r.pharmacy_name ?? "—"} · {timeAgo(r.created_at)}
                </div>
              </div>
              <StatusPill status={r.status} />
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
