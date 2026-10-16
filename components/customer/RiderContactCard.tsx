"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, MessageCircle, Phone, ShieldCheck } from "lucide-react";
import { Button, Card, toast } from "@/components/ui";
import { api } from "@/lib/client";

/**
 * Lets the customer reach the rider carrying their order.
 *
 * A delivery fails in the field when two people cannot talk to each other, so
 * the contact affordance belongs to the customer, not just the pharmacy. The
 * number starts masked and is released only when tapped — a `tel:` link is not
 * something a page should quietly preload — and the server audits every reveal.
 */
interface ContactState {
  available: boolean;
  reason?: string;
  riderName?: string;
  vehicleNumber?: string | null;
  phoneMasked?: string;
  phone?: string;
  pharmacyName?: string | null;
}

export default function RiderContactCard({ requestId }: { requestId: number }) {
  const [contact, setContact] = useState<ContactState | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ContactState>(`/api/requests/${requestId}/contact`);
      setContact(res);
    } catch {
      // No rider yet is the normal case, not an error worth surfacing loudly.
      setContact(null);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new rider assignment invalidates a previously revealed number.
  useEffect(() => {
    setRevealed(false);
  }, [contact?.riderName]);

  async function reveal() {
    setBusy(true);
    try {
      const res = await api.post<ContactState>(`/api/requests/${requestId}/contact`, { reveal: true });
      setContact(res);
      setRevealed(true);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not share the number", "error");
    } finally {
      setBusy(false);
    }
  }

  // Render nothing until there is genuinely someone to contact; a card that
  // says "no rider yet" on every pickup order is just noise.
  if (!contact?.available || !contact.phoneMasked) return null;

  const phone = revealed ? contact.phone : null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Your rider</h2>
          <p className="text-sm text-slate-500">
            {contact.riderName}
            {contact.vehicleNumber ? ` · ${contact.vehicleNumber}` : ""}
          </p>
        </div>
        <Button variant="ghost" onClick={revealed ? () => setRevealed(false) : reveal} loading={busy && !revealed}>
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {revealed ? "Hide" : "Show number"}
        </Button>
      </div>

      <p className="mt-3 font-mono text-lg tracking-wider text-slate-900">
        {revealed && phone ? phone : contact.phoneMasked}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* tel: and sms: hand off to the dialer and the messaging app, so this
            works on a phone without the web app shipping an SMS gateway. */}
        <a
          href={phone ? `tel:${phone}` : undefined}
          aria-disabled={!phone}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            phone
              ? "bg-teal-600 text-white hover:bg-teal-700"
              : "pointer-events-none bg-slate-100 text-slate-400"
          }`}
        >
          <Phone className="h-4 w-4" /> Call
        </a>
        <a
          href={
            phone
              ? `sms:${phone}?&body=${encodeURIComponent(
                  `Hi ${contact.riderName ?? ""}, this is about MediMesh order #${requestId}.`
                )}`
              : undefined
          }
          aria-disabled={!phone}
          className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            phone
              ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
              : "pointer-events-none bg-slate-100 text-slate-400"
          }`}
        >
          <MessageCircle className="h-4 w-4" /> Text
        </a>
      </div>

      {!revealed ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-slate-500">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          The number is hidden until you ask for it, so it is not sitting on this page
          uninvited. MediMesh records each time it is shared.
        </p>
      ) : null}
    </Card>
  );
}