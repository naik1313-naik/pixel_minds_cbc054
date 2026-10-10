import type { Metadata } from "next";
import "./globals.css";
import NavBar from "@/components/NavBar";
import { Toaster } from "@/components/ui";

export const metadata: Metadata = {
  title: "MediMesh — Medicine availability & delivery network",
  description:
    "A trusted medicine availability, reservation and delivery network for pharmacies, customers and delivery partners.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <NavBar />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-16 pt-10 text-center text-xs text-slate-400">
          MediMesh is a demonstration prototype with fictional data. Substitutes are suggestions only and require
          pharmacist approval.
        </footer>
        <Toaster />
      </body>
    </html>
  );
}
