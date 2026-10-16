"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, CheckCircle2, Clock, MapPin, Package, ShieldCheck, Store, Truck, XCircle } from "lucide-react";
import { Alert, Badge, Button, Card, Spinner, StatusPill, toast } from "@/components/ui";
import { api, formatRupees, timeAgo } from "@/lib/client";
import { useEventStream } from "@/lib/useEventStream";
import DeliveryAuditTimeline from "@/components/blockchain/DeliveryAuditTimeline";
import PaymentPanel from "@/components/customer/PaymentPanel";
import RiderContactCard from "@/components/customer/RiderContactCard";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

interface Detail {
  request: {
    id: number;
    medicine_id: number;
    qty: number;
    secured_qty: number;
    status: string;
    fulfilment_type: string;
    delivery_address: string | null;
    delivery_lat: number | null;
    delivery_lng: number | null;
    rx_verified: number;
    created_at: string;
    customer_name: string;
  };
  medicine: { id: number; name: string; salt: string; price_paise: number; rx_required: number } | null;
  pharmacy: { id: number; name: string; address: string; lat: number; lng: number } | null;
  reservations: { id: number; pharmacy_id: number; pharmacy_name: string; qty: number; status: string; kind: string }[];
  delivery: {
    id: number;
    status: string;
    partner_id: number | null;
    otp_active: number;
    distance_km: number | null;
    eta_minutes: number | null;
    destination_lat: number;
    destination_lng: number;
  } | null;
}

const PICKUP_STEPS = ["Requested", "Sourcing", "Confirmed", "Ready", "Completed"];

export default function RequestTracker({ requestId }: { requestId: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rider, setRider] = useState<{ lat: number; lng: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [track, setTrack] = useState<{ lat: number; lng: number }[]>([]);
  const [otp, setOtp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<Detail>(`/api/requests/${requestId}`);
      setDetail(d);
      setLoadError(null);
      if (d.delivery) {
        const dv = await api.get<{
          last_location: { lat: number; lng: number; heading?: number | null } | null;
          track: { lat: number; lng: number }[];
        }>(`/api/rider/deliveries/${d.delivery.id}`);
        if (dv.last_location) setRider({ lat: dv.last_location.lat, lng: dv.last_location.lng });
        setTrack(dv.track.map((t) => ({ lat: t.lat, lng: t.lng })));
        setHeading(typeof dv.last_location?.heading === "number" ? dv.last_location.heading : null);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this request");
    }
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(`/api/requests/${requestId}/stream`, (e: unknown) => {
    const ev = e as { type: string; lat?: number; lng?: number; heading?: number | null };
    if (ev.type === "location" && typeof ev.lat === "number" && typeof ev.lng === "number") {
      setRider({ lat: ev.lat, lng: ev.lng });
      if (typeof ev.heading === "number") setHeading(ev.heading);
      setTrack((t) => [...t, { lat: ev.lat as number, lng: ev.lng as number }]);
    } else {
      load();
    }
  });

  async function revealOtp() {
    try {
      const res = await api.get<{ otp: string | null }>(`/api/requests/${requestId}/otp`);
      setOtp(res.otp);
    } catch (err) {
      toast(err instanceof Error ? err.message : "No OTP yet", "error");
    }
  }

  async function act(action: "cancel" | "complete") {
    setBusy(true);
    try {
      await api.post(`/api/requests/${requestId}/${action}`);
      toast(action === "cancel" ? "Request cancelled" : "Marked as collected", "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    if (loadError) {
      return (
        <div className="space-y-4">
          <Alert><span>{loadError}</span></Alert>
          <Link href="/app" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-teal-700">
            <ArrowLeft className="h-4 w-4" /> Back to search
          </Link>
        </div>
      );
    }
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="h-8 w-8 text-teal-600" />
      </div>
    );
  }

  const { request, medicine, pharmacy, reservations, delivery } = detail;
  const isDelivery = request.fulfilment_type === "delivery";
  const currentIdx = PICKUP_STEPS.indexOf(request.status);
  const canCancel = ["Requested", "Sourcing", "NeedsVerification", "PartialOffer", "Confirmed", "Ready"].includes(request.status);
  const canComplete = !isDelivery && ["Ready", "Confirmed"].includes(request.status);

  return (
    <div className="space-y-5">
      <Link href="/app" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-teal-700">
        <ArrowLeft className="h-4 w-4" /> Back to search
      </Link>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {request.qty} × {medicine?.name}
            </h1>
            <p className="text-sm text-slate-500">
              Request #{request.id} · {isDelivery ? "Home delivery" : "Pickup"} · {timeAgo(request.created_at)}
              {medicine ? ` · ${formatRupees(medicine.price_paise * request.qty)}` : ""}
            </p>
          </div>
          <StatusPill status={request.status} />
        </div>

        {medicine?.rx_required ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-purple-50 px-3 py-2 text-sm text-purple-800">
            <ShieldCheck className="h-4 w-4" />
            Prescription medicine — {request.rx_verified ? "verified by the pharmacy" : "awaiting pharmacy verification"}.
          </div>
        ) : null}
        {request.secured_qty > 0 && request.secured_qty < request.qty ? (
          <div className="mt-3 rounded-xl bg-orange-50 px-3 py-2 text-sm text-orange-800">
            Partial availability: {request.secured_qty} of {request.qty} units secured.
          </div>
        ) : null}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-slate-900">Progress</h2>
        {isDelivery ? (
          <DeliveryProgress status={delivery?.status ?? "—"} />
        ) : (
          <div className="mt-4 flex items-center">
            {PICKUP_STEPS.map((step, i) => (
              <div key={step} className="flex flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center">
                  <div
                    className={`grid h-8 w-8 place-items-center rounded-full text-xs font-bold ${
                      i <= currentIdx ? "bg-teal-600 text-white" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {i < currentIdx ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <span className="mt-1 hidden text-[10px] font-medium text-slate-500 sm:block">{step.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                </div>
                {i < PICKUP_STEPS.length - 1 && <div className={`mx-1 h-0.5 flex-1 ${i < currentIdx ? "bg-teal-500" : "bg-slate-200"}`} />}
              </div>
            ))}
          </div>
        )}
      </Card>

      <PaymentPanel requestId={requestId} requestStatus={request.status} onPaid={load} />

      {isDelivery && <RiderContactCard requestId={requestId} />}

      {pharmacy && (
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Store className="h-4 w-4 text-slate-400" /> Fulfilling pharmacy</h2>
          <p className="mt-1 text-sm text-slate-700">{pharmacy.name}</p>
          <p className="text-xs text-slate-500">{pharmacy.address}</p>
          {reservations.length > 1 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-semibold uppercase text-slate-400">Split across stores</p>
              {reservations.map((r) => (
                <div key={r.id} className="flex justify-between text-xs text-slate-600">
                  <span>{r.pharmacy_name}</span>
                  <span>{r.qty} units · {r.status}{r.kind === "primary" ? "" : ` (${r.kind})`}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {isDelivery && delivery && (
        <Card className="overflow-hidden p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Truck className="h-4 w-4 text-slate-400" /> Live delivery</h2>
            <Badge tone={delivery.status === "Delivered" ? "emerald" : "amber"}>{delivery.status.replace(/([a-z])([A-Z])/g, "$1 $2")}</Badge>
          </div>
          {delivery.distance_km != null && (
            <p className="mt-1 text-xs text-slate-500">
              {delivery.distance_km.toFixed(1)} km · about {delivery.eta_minutes} min
            </p>
          )}
          <div className="mt-4 overflow-hidden rounded-xl">
            <MapView
              pharmacy={pharmacy ? { lat: pharmacy.lat, lng: pharmacy.lng } : null}
              destination={{ lat: delivery.destination_lat, lng: delivery.destination_lng }}
              rider={rider}
              track={track}
              heading={heading}
              className="h-[340px] w-full"
            />
          </div>
          {delivery.status === "ArrivedAtDestination" && (
            <div className="mt-4 rounded-xl bg-teal-50 p-3">
              <p className="text-sm text-teal-900">Your delivery has arrived. Share this OTP with the rider:</p>
              {otp ? (
                <p className="mt-1 text-3xl font-bold tracking-[0.3em] text-teal-700">{otp}</p>
              ) : (
                <Button variant="ghost" className="mt-2" onClick={revealOtp}>Reveal demo OTP</Button>
              )}
            </div>
          )}
          <div className="mt-5">
            <DeliveryAuditTimeline deliveryId={delivery.id} />
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        {canComplete && (
          <Button loading={busy} onClick={() => act("complete")}>
            <CheckCircle2 className="h-4 w-4" /> Mark as collected
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" loading={busy} onClick={() => act("cancel")}>
            <XCircle className="h-4 w-4" /> Cancel request
          </Button>
        )}
      </div>

      {["Unavailable", "Rejected", "Expired", "Cancelled"].includes(request.status) && (
        <Alert kind="info">
          <span>
            This request is {request.status.toLowerCase()}. <Link href="/app" className="font-semibold underline">Search again</Link>.
          </span>
        </Alert>
      )}
    </div>
  );
}

function DeliveryProgress({ status }: { status: string }) {
  const steps = ["SearchingPartner", "AwaitingPharmacyApproval", "Assigned", "ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination", "Delivered"];
  const idx = steps.indexOf(status);
  return (
    <div className="mt-4 space-y-2">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-3">
          <div className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold ${i <= idx ? "bg-teal-600 text-white" : "bg-slate-200 text-slate-500"}`}>
            {i < idx ? <CheckCircle2 className="h-3.5 w-3.5" /> : i === idx ? <Clock className="h-3.5 w-3.5" /> : <Package className="h-3.5 w-3.5" />}
          </div>
          <span className={`text-sm ${i <= idx ? "text-slate-800" : "text-slate-400"}`}>{s.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
        </div>
      ))}
      <p className="flex items-center gap-1 pt-1 text-xs text-slate-400"><MapPin className="h-3 w-3" /> Live location updates every few seconds.</p>
    </div>
  );
}
