"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  Boxes,
  MapPin,
  Navigation,
  Package,
  Pill,
  Search,
  Shield,
  Store,
  Truck,
  Users,
} from "lucide-react";
import { Card } from "@/components/ui";

interface Stats {
  pharmacies: number;
  medicines: number;
  networkUnits: number;
  areas: number;
}

export default function Landing({ stats }: { stats: Stats }) {
  return (
    <div className="space-y-24 pb-10">
      <Hero stats={stats} />
      <Story />
      <Roles />
      <CTA />
    </div>
  );
}

function Hero({ stats }: { stats: Stats }) {
  return (
    <section className="gradient-mesh relative overflow-hidden rounded-3xl border border-slate-200 px-6 py-16 sm:px-12 sm:py-24">
      <div className="mx-auto max-w-3xl text-center">
        <motion.span
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-white/70 px-3 py-1 text-xs font-semibold text-teal-700"
        >
          <Activity className="h-3.5 w-3.5" /> Real-time medicine availability network
        </motion.span>
        <motion.h1
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mt-5 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-6xl"
        >
          Every medicine,
          <span className="text-teal-600"> one mesh.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="mx-auto mt-5 max-w-2xl text-lg text-slate-600"
        >
          MediMesh connects customers, pharmacies and delivery partners. When one store is out of stock,
          the network reserves it from the nearest store that has it — with a 30-minute soft lock, a
          transparent ledger, and doorstep delivery.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            href="/register"
            className="inline-flex items-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-teal-600/20 hover:bg-teal-700"
          >
            Get started <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Explore the live demo
          </Link>
        </motion.div>
        <div className="mt-12 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat icon={<Store className="h-4 w-4" />} label="Pharmacies" value={stats.pharmacies} />
          <Stat icon={<Pill className="h-4 w-4" />} label="Medicines" value={stats.medicines} />
          <Stat icon={<Boxes className="h-4 w-4" />} label="Units in network" value={stats.networkUnits} />
          <Stat icon={<MapPin className="h-4 w-4" />} label="Areas covered" value={stats.areas} />
        </div>
      </div>
    </section>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-left">
      <div className="flex items-center gap-2 text-teal-600">{icon}<span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span></div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value.toLocaleString("en-IN")}</div>
    </div>
  );
}

const STEPS = [
  {
    icon: <Search className="h-6 w-6" />,
    title: "1 · Search & reserve",
    body: "A customer searches a medicine. MediMesh instantly ranks nearby verified pharmacies by distance, stock confidence, response time and fulfilment history.",
  },
  {
    icon: <Shield className="h-6 w-6" />,
    title: "2 · Soft lock for 30 minutes",
    body: "The best stock is reserved with an atomic, expiring lock. If two people race for the last strip, exactly one wins — never an oversell.",
  },
  {
    icon: <Truck className="h-6 w-6" />,
    title: "3 · Pickup or delivery",
    body: "Choose counter pickup or doorstep delivery. A delivery partner is offered the job, navigates with live tracking, and completes handover with an OTP.",
  },
];

function Story() {
  return (
    <section className="mx-auto max-w-5xl">
      <h2 className="text-center text-3xl font-bold text-slate-900">How the mesh works</h2>
      <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600">
        One medicine can be split across several stores and borrowed between them. Every movement is recorded
        in a wholesale ledger with platform fees.
      </p>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <motion.div
            key={s.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1 }}
          >
            <Card className="h-full p-6">
              <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-teal-50 text-teal-700">{s.icon}</div>
              <h3 className="text-lg font-semibold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </Card>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

const ROLE_CARDS = [
  { icon: <Users className="h-5 w-5" />, title: "Customers", body: "Find, reserve and receive medicine with live tracking and an auditable history." },
  { icon: <Store className="h-5 w-5" />, title: "Pharmacies", body: "Serve requests, manage inventory, and earn by lending stock into the mesh." },
  { icon: <Navigation className="h-5 w-5" />, title: "Delivery partners", body: "Accept nearby jobs, navigate, and prove handover with OTP + ID checks." },
  { icon: <Shield className="h-5 w-5" />, title: "Administrators", body: "Verify pharmacies and partners, review the audit log, and monitor the network." },
];

function Roles() {
  return (
    <section className="mx-auto max-w-5xl">
      <h2 className="text-center text-3xl font-bold text-slate-900">Built for every side of the mesh</h2>
      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {ROLE_CARDS.map((r, i) => (
          <motion.div
            key={r.title}
            initial={{ opacity: 0, scale: 0.96 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.05 }}
          >
            <Card className="h-full p-5">
              <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-slate-900 text-white">{r.icon}</div>
              <h3 className="font-semibold text-slate-900">{r.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{r.body}</p>
            </Card>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="mx-auto max-w-4xl">
      <Card className="flex flex-col items-center gap-4 bg-slate-900 p-10 text-center text-white">
        <Package className="h-8 w-8 text-teal-400" />
        <h2 className="text-2xl font-bold">Try the full prototype</h2>
        <p className="max-w-xl text-slate-300">
          Demo accounts for every role are generated on first run. Sign in as a customer, pharmacy, delivery
          partner or administrator to explore the complete flow.
        </p>
        <Link
          href="/login"
          className="mt-2 inline-flex items-center gap-2 rounded-xl bg-teal-500 px-5 py-3 text-sm font-semibold text-white hover:bg-teal-400"
        >
          Open the demo <ArrowRight className="h-4 w-4" />
        </Link>
      </Card>
    </section>
  );
}
