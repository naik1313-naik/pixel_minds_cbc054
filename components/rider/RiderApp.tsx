"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Locate, Navigation, Package, Play, Square, Truck } from "lucide-react";
import { Alert, Badge, Button, Card, Input, StatusPill, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";
import { useEventStream } from "@/lib/useEventStream";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface Offer {
  id: number;
  offer_id: number;
  pharmacy_id: number;
  pharmacy_name: string;
  status: string;
  destination_address: string;
  distance_km: number | null;
  eta_minutes: number | null;
  rx_required: number;
  offered_at: string;
  expires_at: string;
}

/** Seconds left to answer, floored at zero. */
function secondsLeft(offer: Offer, now: number): number {
  return Math.max(0, Math.round((new Date(offer.expires_at).getTime() - now) / 1000));
}
interface DeliveryDetail {
  delivery: { id: number; status: string; rx_required: number; distance_km: number | null; eta_minutes: number | null; destination_lat: number; destination_lng: number; destination_address: string };
  pharmacy: { name: string; lat: number; lng: number } | null;
  partner: { name: string; phone_masked: string } | null;
  request: { medicine_id: number } | null;
  last_location: { lat: number; lng: number; heading?: number | null } | null;
  track: { lat: number; lng: number }[];
}

const NEXT_STATUS: Record<string, string> = {
  Assigned: "ArrivedAtPharmacy",
  ArrivedAtPharmacy: "PickedUp",
  PickedUp: "OutForDelivery",
  OutForDelivery: "ArrivedAtDestination",
};

/**
 * Mirrors the app's delivery statuses onto the four on-chain milestones.
 * Packed is recorded by the pharmacy when it marks the parcel ready.
 */
const MILESTONE_FOR_STATUS: Record<string, "Packed" | "PickedUp" | "OutForDelivery" | "Delivered"> = {
  PickedUp: "PickedUp",
  OutForDelivery: "OutForDelivery",
  ArrivedAtDestination: "Delivered",
};

export default function RiderApp({
  name,
  online,
  partnerStatus,
}: {
  name: string;
  online: boolean;
  partnerStatus: string;
}) {
  const [isOnline, setIsOnline] = useState(online);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [rider, setRider] = useState<{ lat: number; lng: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [track, setTrack] = useState<{ lat: number; lng: number }[]>([]);
  const [otp, setOtp] = useState("");
  const [idChecked, setIdChecked] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  // Ticks once a second so offer countdowns stay honest without a reload.
  const [now, setNow] = useState(() => Date.now());
  const simRef = useRef<number | null>(null);
  const tRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const refreshOffers = useCallback(async () => {
    try {
      const res = await api.get<{ offers: Offer[]; deliveries: { id: number; status: string }[] }>("/api/rider/deliveries");
      setOffers(res.offers);
      if (activeId == null) {
        const active = res.deliveries.find((d) => !["Delivered", "Cancelled", "ReturnedToPharmacy"].includes(d.status));
        if (active) setActiveId(active.id);
      }
    } catch {
      /* ignore */
    }
  }, [activeId]);

  useEffect(() => {
    refreshOffers();
  }, [refreshOffers]);

  useEventStream("/api/rider/stream", (e: unknown) => {
    const ev = e as { type: string };
    if (ev.type === "delivery") refreshOffers();
  });

  const loadDetail = useCallback(async (id: number) => {
    const d = await api.get<DeliveryDetail>(`/api/rider/deliveries/${id}`);
    setDetail(d);
    setRider(d.last_location ?? (d.pharmacy ? { lat: d.pharmacy.lat, lng: d.pharmacy.lng } : null));
    setHeading(typeof d.last_location?.heading === "number" ? d.last_location.heading : null);
    setTrack(d.track.map((p) => ({ lat: p.lat, lng: p.lng })));
  }, []);

  useEffect(() => {
    if (activeId != null) loadDetail(activeId);
  }, [activeId, loadDetail]);

  async function toggleOnline() {
    try {
      await api.post("/api/rider/status", { online: !isOnline });
      setIsOnline(!isOnline);
      toast(!isOnline ? "You are online" : "You are offline", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    }
  }

  async function offerAction(deliveryId: number, action: "accept" | "decline") {
    setBusy(true);
    try {
      await api.post("/api/rider/offers", { deliveryId, action });
      if (action === "accept") {
        setActiveId(deliveryId);
        toast("Job accepted", "success");
      } else {
        toast("Job declined", "info");
      }
      await refreshOffers();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function advance() {
    if (!detail) return;
    const next = NEXT_STATUS[detail.delivery.status];
    if (!next) return;
    setBusy(true);
    try {
      await api.post(`/api/rider/deliveries/${detail.delivery.id}/status`, { status: next });
      // Mirror the milestone on-chain. Failure here must NOT block the rider's
      // real workflow, so it is reported without reverting the status change.
      const milestone = MILESTONE_FOR_STATUS[next];
      if (milestone) {
        try {
          await api.post(`/api/blockchain/deliveries/${detail.delivery.id}/events`, { milestone });
        } catch (chainErr) {
          toast(
            chainErr instanceof Error
              ? `Status updated, but the on-chain audit record failed: ${chainErr.message}`
              : "Status updated, but the on-chain audit record failed",
            "error"
          );
        }
      }
      await loadDetail(detail.delivery.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function startSim() {
    if (!detail?.pharmacy) return;
    if (simRef.current) return;
    setSimRunning(true);
    simRef.current = window.setInterval(async () => {
      tRef.current = Math.min(1, tRef.current + 0.06);
      const from = detail.pharmacy!;
      const to = { lat: detail.delivery.destination_lat, lng: detail.delivery.destination_lng };
      const lat = from.lat + (to.lat - from.lat) * tRef.current;
      const lng = from.lng + (to.lng - from.lng) * tRef.current;
      setRider({ lat, lng });
      try {
        await api.post(`/api/rider/deliveries/${detail.delivery.id}/location`, { lat, lng, speed: 8 });
      } catch {
        /* ignore */
      }
      if (tRef.current >= 1) stopSim();
    }, 1500);
  }
  function stopSim() {
    if (simRef.current) window.clearInterval(simRef.current);
    simRef.current = null;
    setSimRunning(false);
  }
  useEffect(() => () => stopSim(), []);

  async function handover() {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post(`/api/rider/deliveries/${detail.delivery.id}/handover`, { otp, idChecked });
      toast("Delivery completed", "success");
      stopSim();
      setOtp("");
      setIdChecked(false);
      setActiveId(null);
      setDetail(null);
      await refreshOffers();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Handover failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const status = detail?.delivery.status;
  const atDestination = status === "ArrivedAtDestination";
  const awaitingApproval = status === "AwaitingPharmacyApproval";
  // A partner waiting on an admin decision cannot take jobs, so the console says
  // so instead of offering a Go online button that the server will refuse.
  const pendingVerification = partnerStatus === "pending";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Hi {name.split(" ")[0]}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            Delivery partner <Badge tone={partnerStatus === "verified" ? "emerald" : "amber"}>{partnerStatus}</Badge>
          </div>
        </div>
        {!pendingVerification ? (
          <Button variant={isOnline ? "danger" : "primary"} onClick={toggleOnline}>
            {isOnline ? <><Square className="h-4 w-4" /> Go offline</> : <><Play className="h-4 w-4" /> Go online</>}
          </Button>
        ) : null}
      </div>

      {pendingVerification ? (
        <Alert kind="info">
          <span>
            Your documents were accepted, but an admin still has to verify you before you can take
            jobs. You will be able to go online as soon as that is done — no need to sign up again.
          </span>
        </Alert>
      ) : null}

      {offers.length > 0 && (
        <Card className="p-5">
          <h2 className="font-semibold text-slate-900">New job offers</h2>
          <div className="mt-3 space-y-3">
            {offers.map((o) => {
              const left = secondsLeft(o, now);
              return (
              <div key={o.offer_id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-100 bg-teal-50/60 p-3">
                <div>
                  <div className="font-medium text-slate-800">{o.pharmacy_name}</div>
                  <div className="text-xs text-slate-500">{o.destination_address}</div>
                  <div className="text-xs text-slate-500">
                    {o.distance_km?.toFixed(1)} km · ~{o.eta_minutes} min {o.rx_required ? "· Rx" : ""}
                  </div>
                  <div className={`mt-1 text-xs font-medium ${left < 20 ? "text-rose-600" : "text-teal-700"}`}>
                    {left > 0 ? `Expires in ${left}s` : "Expired — refreshing"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button loading={busy} onClick={() => offerAction(o.id, "accept")}>Accept</Button>
                  <Button variant="ghost" loading={busy} onClick={() => offerAction(o.id, "decline")}>Decline</Button>
                </div>
              </div>
              );
            })}
          </div>
        </Card>
      )}

      {detail ? (
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Truck className="h-4 w-4 text-slate-400" /> Active job #{detail.delivery.id}</h2>
            <StatusPill status={detail.delivery.status} />
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Pick up from <strong>{detail.pharmacy?.name}</strong> → deliver to {detail.delivery.destination_address}
          </p>

          {awaitingApproval && (
            <div className="mt-3">
              <Alert kind="info"><span>Waiting for the pharmacy to approve your assignment before you can proceed.</span></Alert>
            </div>
          )}

          <div className="mt-4 overflow-hidden rounded-xl">
            <MapView
              pharmacy={detail.pharmacy ? { lat: detail.pharmacy.lat, lng: detail.pharmacy.lng } : null}
              destination={{ lat: detail.delivery.destination_lat, lng: detail.delivery.destination_lng }}
              rider={rider}
              track={track}
              heading={heading}
              className="h-[340px] w-full"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {NEXT_STATUS[detail.delivery.status] && (
              <Button loading={busy} onClick={advance}>
                <Navigation className="h-4 w-4" /> Mark {NEXT_STATUS[detail.delivery.status].replace(/([a-z])([A-Z])/g, "$1 $2")}
              </Button>
            )}
            {!atDestination && !awaitingApproval && (
              simRunning ? (
                <Button variant="danger" onClick={stopSim}><Square className="h-4 w-4" /> Stop simulator</Button>
              ) : (
                <Button variant="ghost" onClick={startSim}><Locate className="h-4 w-4" /> Start location simulator</Button>
              )
            )}
          </div>

          {atDestination && (
            <div className="mt-4 space-y-3 rounded-xl bg-slate-50 p-4">
              <h3 className="font-semibold text-slate-800">Proof of handover</h3>
              <Input label="Customer OTP" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="4-digit OTP" />
              {detail.delivery.rx_required ? (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={idChecked} onChange={(e) => setIdChecked(e.target.checked)} />
                  Recipient ID checked (required for prescription medicine)
                </label>
              ) : null}
              <Button loading={busy} onClick={handover}><Package className="h-4 w-4" /> Complete handover</Button>
            </div>
          )}
          {detail.delivery.distance_km != null && (
            <p className="mt-2 text-xs text-slate-400">{detail.delivery.distance_km.toFixed(1)} km · ~{detail.delivery.eta_minutes} min · fare {formatRupees(5000)}</p>
          )}
        </Card>
      ) : (
        <Card className="p-10 text-center">
          <Truck className="mx-auto mb-2 h-8 w-8 text-slate-300" />
          {offers.length ? (
            <p className="text-sm text-slate-400">Accept an offer to start a job.</p>
          ) : isOnline ? (
            <>
              <p className="text-sm font-medium text-slate-600">You&apos;re online — waiting for jobs.</p>
              <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-slate-400">
                A job appears here the moment a pharmacy marks a delivery order <strong>Ready</strong>.
                Pickup orders never generate delivery work, so a quiet board is usually a quiet
                pharmacy rather than a problem.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-400">Go online to receive jobs.</p>
          )}
        </Card>
      )}
    </div>
  );
}
