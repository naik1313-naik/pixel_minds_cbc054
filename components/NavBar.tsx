import Link from "next/link";
import { Activity, Pill } from "lucide-react";
import { getCurrentUser } from "@/lib/session";
import LogoutButton from "./LogoutButton";

const LINKS: Record<string, { href: string; label: string }[]> = {
  customer: [
    { href: "/app", label: "Find medicine" },
    { href: "/assistant", label: "AI assistant" },
    { href: "/insights", label: "Network insights" },
  ],
  pharmacy_owner: [
    { href: "/pharmacy", label: "Pharmacy console" },
    { href: "/assistant", label: "AI assistant" },
    { href: "/insights", label: "Network insights" },
  ],
  pharmacy_staff: [
    { href: "/pharmacy", label: "Pharmacy console" },
    { href: "/assistant", label: "AI assistant" },
    { href: "/insights", label: "Network insights" },
  ],
  delivery_partner: [
    { href: "/rider", label: "Delivery app" },
    { href: "/assistant", label: "AI assistant" },
  ],
  admin: [
    { href: "/admin", label: "Admin" },
    { href: "/assistant", label: "AI assistant" },
    { href: "/insights", label: "Network insights" },
  ],
};

export default async function NavBar() {
  const current = await getCurrentUser();
  const links = current ? LINKS[current.user.role] ?? [] : [];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold text-slate-900">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-600 text-white">
            <Pill className="h-4 w-4" />
          </span>
          MediMesh
        </Link>
        <div className="flex items-center gap-2 sm:gap-4">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="hidden text-sm font-medium text-slate-600 hover:text-teal-700 sm:block"
            >
              {l.label}
            </Link>
          ))}
          {current ? (
            <div className="flex items-center gap-3">
              <span className="hidden text-right text-xs leading-tight text-slate-500 sm:block">
                <span className="block font-semibold text-slate-700">{current.user.name}</span>
                {current.user.role.replace("_", " ")}
              </span>
              <LogoutButton />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/login" className="text-sm font-semibold text-slate-600 hover:text-teal-700">
                Sign in
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center gap-1 rounded-xl bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
              >
                <Activity className="h-4 w-4" /> Get started
              </Link>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
