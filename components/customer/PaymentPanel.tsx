"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CreditCard, ExternalLink, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { Alert, Button, Card, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

/**
 * Customer checkout + settlement receipt.
 *
 * Two states in one place because they are the same story: before payment there
 * is nothing to pay, after payment there is a receipt worth showing. The
 * on-chain receipt is deliberately worded as what it proves — an authorized
 * wallet reported the settlement — and never as proof that money moved.
 */
export interface PaymentView {
  paymentId: number;
  requestId: number;
  status: string;
  amountPaise: number;
  platformFeePaise: number;
  pharmacyAmountPaise: number;
  amountLabel: string;
  gateway: string;
  razorpayOrderId: string | null;
  razorpayTransferId: string | null;
  payoutAccountReady: boolean;
  capturedAt: string | null;
  paidOutAt: string | null;
  failureReason: string | null;
  settlement: {
    settlementRef: string;
    settlementRefHash: string;
    status: string;
    txHash: string | null;
    blockNumber: number | null;
    error: string | null;
  } | null;
}

interface Props {
  requestId: number;
  /** Current order status, so the panel can explain an absent payment step. */
  requestStatus?: string;
  /** Refreshes the parent tracker after a successful payment. */
  onPaid?: () => void;
}

const EXPLORER = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? "";

/** After these the order is settled one way or another; no payment panel. */
const CANCELLED_STATUSES = new Set(["Rejected", "Cancelled", "Unavailable", "Expired"]);
const CONFIRMED_STATUSES = new Set(["Confirmed", "Ready", "Completed"]);

export default function PaymentPanel({ requestId, requestStatus, onPaid }: Props) {
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ payment: PaymentView | null }>(`/api/requests/${requestId}/payment`);
      setPayment(res.payment);
      setError(null);
    } catch (e) {
      // A payment panel must never be the thing that breaks the page.
      setError(e instanceof Error ? e.message : "Could not load payment status");
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        razorpayOrderId: string;
        amountPaise: number;
        razorpayKeyId: string | null;
        gateway: string;
      }>(`/api/requests/${requestId}/payment`);

      if (res.gateway === "demo" || !res.razorpayKeyId) {
        // No live merchant keys configured: replay the same callback the
        // checkout widget would produce, so the rest of the flow is exercised
        // end to end without any money moving.
        await api.post("/api/payments/verify", {
          razorpayOrderId: res.razorpayOrderId,
          razorpayPaymentId: `pay_demo_${res.razorpayOrderId.replace(/^order_demo_/, "")}`,
          // The demo rail verifies the id shape, not a signature; the field
          // still has to be present and well-formed.
          razorpaySignature: "demo-signature-not-required",
        });
      } else {
        await openCheckout(res.razorpayKeyId, res.razorpayOrderId, requestId);
      }
      toast("Payment received");
      await load();
      onPaid?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
      toast("Payment failed");
    } finally {
      setBusy(false);
    }
  };

  // A payment intent only opens when the pharmacy confirms the order — that is
  // when the quantity and price become final. Rather than render nothing (which
  // reads as "this app has no payment"), say what is happening and why.
  if (!payment) {
    if (!requestStatus) return null;
    if (CANCELLED_STATUSES.has(requestStatus)) return null;
    const pharmacyConfirmed = CONFIRMED_STATUSES.has(requestStatus);
    return (
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <div>
            <h2 className="font-semibold text-slate-900">Payment</h2>
            <p className="mt-1 text-sm text-slate-500">
              {pharmacyConfirmed
                ? "Your pharmacy is confirming the stock. The total is fixed at that point and the payment option appears here."
                : "Payment opens once the pharmacy confirms your order, so the amount charged always matches what you actually receive."}
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const paid = payment.status === "Captured" || payment.status === "PaidOut";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-slate-900">
            <CreditCard className="h-4 w-4" /> Payment
          </h2>
          <p className="text-sm text-slate-500">
            {payment.amountLabel} for this order · paid to the pharmacy, not to MediMesh
          </p>
        </div>
        <StatusBadge status={payment.status} />
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {!paid ? (
        <div className="mt-4 space-y-3">
          {!payment.payoutAccountReady ? (
            <Alert>
              This pharmacy has not finished activating its payout account, so payment is held until
              it does. You will not be charged.
            </Alert>
          ) : null}
          <Button onClick={pay} disabled={busy} className="w-full">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {payment.status === "Failed" ? "Retry payment" : `Pay ${payment.amountLabel}`}
          </Button>
          {payment.status === "Awaiting" ? (
            <p className="text-xs text-slate-500">
              Your pharmacy confirms the stock first; the total is fixed then and cannot change.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            {payment.status === "PaidOut"
              ? "Delivered. The pharmacy has been paid."
              : "Paid. The pharmacy is paid once your order is fulfilled."}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-slate-500">Order total</dt>
              <dd className="font-medium text-slate-900">{payment.amountLabel}</dd>
            </div>
            <div>
              <dt className="text-slate-500">To pharmacy</dt>
              <dd className="font-medium text-slate-900">
                {formatRupees(payment.pharmacyAmountPaise)}
              </dd>
            </div>
          </dl>
          <SettlementReceipt payment={payment} />
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    Awaiting: "bg-amber-100 text-amber-800",
    Captured: "bg-sky-100 text-sky-800",
    PaidOut: "bg-emerald-100 text-emerald-800",
    Refunded: "bg-slate-100 text-slate-700",
    Failed: "bg-rose-100 text-rose-800",
    Cancelled: "bg-slate-100 text-slate-700",
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone[status] ?? tone.Awaiting}`}>
      {status === "PaidOut" ? "Paid to pharmacy" : status}
    </span>
  );
}

/**
 * On-chain receipt.
 *
 * States exactly what the anchor proves and stops there. Overclaiming here would
 * be the single most misleading thing this screen could do.
 */
function SettlementReceipt({ payment }: { payment: PaymentView }) {
  const s = payment.settlement;
  if (!s || s.status !== "Settled") {
    return (
      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
        {s
          ? "Recording the settlement on the ledger…"
          : "The settlement receipt appears here once your order is fulfilled."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {/* Printable receipt: the pharmacy can hand this over, and anyone who
          scans it checks the claim themselves. */}
      <div className="flex items-start gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/requests/${payment.requestId}/payment/qr`}
          alt="QR code linking to the public settlement verification"
          className="h-24 w-24 shrink-0 rounded-lg bg-white p-1"
        />
        <div className="text-xs text-slate-500">
          <p className="font-medium text-slate-700">Scan to verify this payout</p>
          <p className="mt-1">
            Anyone who scans this sees that a pharmacy wallet reported this settlement and that the
            record has not changed since.
          </p>
          <button
            type="button"
            onClick={() => window.print()}
            className="mt-2 text-xs font-medium text-teal-700 hover:underline"
          >
            Print this receipt
          </button>
        </div>
      </div>
      <div className="space-y-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <p className="flex items-center gap-1.5 font-medium text-slate-700">
        <ShieldCheck className="h-3.5 w-3.5" /> Recorded on the MediMesh ledger
      </p>
      <p className="font-mono break-all">ref {s.settlementRefHash}</p>
      {s.blockNumber != null ? <p>block #{s.blockNumber}</p> : null}
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        <Link
          href={`/verify/settlement/${s.settlementRef}`}
          target="_blank"
          className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline"
        >
          Verify publicly <ExternalLink className="h-3 w-3" />
        </Link>
        {s.txHash && EXPLORER ? (
          <a
            className="text-teal-700 hover:underline"
            href={`${EXPLORER}/tx/${s.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {s.txHash.slice(0, 18)}…
          </a>
        ) : null}
      </div>
      <p className="text-slate-500">
        Anyone can open the verify link — no account needed. It proves an authorised pharmacy wallet
        reported this settlement and that the record has not changed since. It is not a bank
        statement.
      </p>
      </div>
    </div>
  );
}

/**
 * Opens Razorpay Checkout and posts the signed result back for capture.
 *
 * The handler reports the gateway's own ids; the server independently verifies
 * the signature before money moves, so nothing here is trusted.
 */
async function openCheckout(keyId: string, orderId: string, requestId: number): Promise<void> {
  const Razorpay = (await import("@/components/payment/RazorpayCheckout")).default;
  await Razorpay(keyId, orderId, requestId);
}

/** Small helper kept next to its only consumer for the payout icon. */
export function WalletIcon() {
  return <Wallet className="h-4 w-4" />;
}