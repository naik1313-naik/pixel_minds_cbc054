"use client";

import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useEffect, useState } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>
  );
}

export function Button({
  children,
  variant = "primary",
  loading,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "subtle"; loading?: boolean }) {
  const styles = {
    primary: "bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-300",
    ghost: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
    subtle: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    danger: "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100",
  }[variant];
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${styles} ${className}`}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
}

export function Input({ label, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>}
      <input
        {...props}
        className={`w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100 ${className}`}
      />
    </label>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

const STATUS_STYLES: Record<string, string> = {
  Requested: "bg-slate-100 text-slate-700",
  Sourcing: "bg-amber-100 text-amber-800",
  NeedsVerification: "bg-purple-100 text-purple-800",
  Confirmed: "bg-sky-100 text-sky-800",
  Ready: "bg-teal-100 text-teal-800",
  Completed: "bg-emerald-100 text-emerald-800",
  PartialOffer: "bg-orange-100 text-orange-800",
  Rejected: "bg-rose-100 text-rose-800",
  Expired: "bg-slate-200 text-slate-600",
  Unavailable: "bg-rose-100 text-rose-800",
  Cancelled: "bg-slate-200 text-slate-600",
  SearchingPartner: "bg-amber-100 text-amber-800",
  AwaitingPharmacyApproval: "bg-orange-100 text-orange-800",
  Assigned: "bg-sky-100 text-sky-800",
  ArrivedAtPharmacy: "bg-indigo-100 text-indigo-800",
  PickedUp: "bg-indigo-100 text-indigo-800",
  OutForDelivery: "bg-teal-100 text-teal-800",
  ArrivedAtDestination: "bg-purple-100 text-purple-800",
  Delivered: "bg-emerald-100 text-emerald-800",
  HandoverFailed: "bg-rose-100 text-rose-800",
  CustomerUnreachable: "bg-rose-100 text-rose-800",
  ReturnedToPharmacy: "bg-rose-100 text-rose-800",
};

export function StatusPill({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-slate-100 text-slate-700";
  const label = status.replace(/([a-z])([A-Z])/g, "$1 $2");
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>{label}</span>;
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "teal" | "amber" | "rose" | "emerald" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    teal: "bg-teal-100 text-teal-800",
    amber: "bg-amber-100 text-amber-800",
    rose: "bg-rose-100 text-rose-800",
    emerald: "bg-emerald-100 text-emerald-800",
  }[tone];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${tones}`}>{children}</span>;
}

export function Alert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  const styles = {
    error: "border-rose-200 bg-rose-50 text-rose-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    info: "border-sky-200 bg-sky-50 text-sky-800",
  }[kind];
  return <div className={`rounded-xl border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

let toastId = 0;
interface ToastItem {
  id: number;
  message: string;
  kind: "error" | "success" | "info";
}
const listeners = new Set<(t: ToastItem[]) => void>();
let toasts: ToastItem[] = [];
export function toast(message: string, kind: ToastItem["kind"] = "info") {
  const item = { id: ++toastId, message, kind };
  toasts = [...toasts, item];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    listeners.forEach((l) => l(toasts));
  }, 4000);
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const l = (t: ToastItem[]) => setItems(t);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-3">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-xl px-4 py-2 text-sm text-white shadow-lg ${
            t.kind === "error" ? "bg-rose-600" : t.kind === "success" ? "bg-emerald-600" : "bg-slate-800"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
