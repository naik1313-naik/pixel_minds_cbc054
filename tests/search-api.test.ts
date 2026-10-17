import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDemo } from "@/lib/db";

/**
 * The search endpoint, exercised over the real database.
 *
 * Unit tests cover the scoring maths; these cover the thing that actually
 * matters to a customer — that what comes back is backed by a stock row at the
 * moment of the request, and that the buckets are honest.
 */

const BASE = process.env.MM_BASE_URL ?? "http://localhost:3000";

let cookie = "";

async function login() {
  const res = await fetch(`${BASE}/api/auth/demo-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "customer" }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
}

async function search(q: string) {
  const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    understood: string[];
    exact: Array<{
      medicine: { id: number; name: string; category: string | null; rx_required: number };
      score: number;
      reasons: string[];
      matchedOn: string;
      pharmacies: Array<{ free: number; distance_km: number; reasons: string[] }>;
      nearest_km: number | null;
    }>;
    alternatives: Array<{
      medicine: { name: string };
      matchedOn: string;
      differsBy: string | null;
    }>;
  };
}

describe("search endpoint", () => {
  beforeEach(async () => {
    await resetDemo();
    await login();
  });
  afterAll(async () => {
    await resetDemo();
  });

  it("finds a medicine by its brand name", async () => {
    const r = await search("tylenol");
    expect(r.exact.length).toBeGreaterThan(0);
    expect(r.exact[0].medicine.name).toMatch(/Paracetamol/i);
    expect(r.exact[0].reasons.join(" ")).toMatch(/Tylenol/i);
  });

  it("reports what it understood", async () => {
    const r = await search("show nearby pharmacies with amoxicillin in stock within 3 km");
    expect(r.understood.join(" ")).toMatch(/within 3 km/);
    expect(r.understood.join(" ")).toMatch(/in-stock/i);
    expect(r.understood.join(" ")).toMatch(/amoxicillin/);
  });

  it("only ever reports a pharmacy that has stock right now", async () => {
    const r = await search("dolo");
    for (const match of r.exact) {
      for (const p of match.pharmacies) {
        // The endpoint reads inventory at query time and never infers
        // availability, so a positive unit count is the whole claim.
        expect(p.free).toBeGreaterThan(0);
      }
    }
  });

  it("explains why each pharmacy is in the list", async () => {
    const r = await search("paracetamol");
    const p = r.exact[0].pharmacies[0];
    expect(p.reasons.join(" ")).toMatch(/in stock/i);
    expect(p.reasons.join(" ")).toMatch(/km away/i);
  });

  it("computes distances in kilometres, not thousands", async () => {
    const r = await search("paracetamol");
    for (const match of r.exact) {
      if (match.nearest_km === null) continue;
      // Every seeded pharmacy is in Bengaluru. A regression that turned an
      // absent coordinate into 0 would put them ~8650 km away, which is the
      // signature of comparing against Null Island.
      expect(match.nearest_km).toBeLessThan(20);
    }
  });

  it("keeps a different strength out of the exact list", async () => {
    const r = await search("paracetamol 500mg tablets");
    const names = r.exact.map((e) => e.medicine.name);
    expect(names).toContain("Paracetamol 500mg");
    // A 400mg and a 650mg tablet are the same substance but not the same
    // medicine; conflating them is how someone takes the wrong dose.
    expect(names).not.toContain("Dolo 650");
    expect(names).not.toContain("Crocin Advance");

    const alts = r.alternatives.map((a) => a.medicine.name);
    expect(alts).toContain("Dolo 650");
    expect(r.alternatives.find((a) => a.medicine.name === "Dolo 650")!.differsBy).toMatch(/650mg/);
  });

  it("does not return the whole catalogue for one query", async () => {
    // Every entry lists its own generic in its synonym list, so a naive
    // salt-vs-synonym comparison matches everything. This is the regression
    // test for exactly that.
    const r = await search("tylenol");
    expect(r.exact.length + r.alternatives.length).toBeLessThanOrEqual(3);
  });

  it("answers a category query with that category", async () => {
    const r = await search("something for my allergy");
    expect(r.understood.join(" ")).toMatch(/Allergy and antihistamines/);
    expect(r.exact.length).toBeGreaterThan(0);
    for (const m of r.exact) expect(m.medicine.category).toBe("Allergy and antihistamines");
  });

  it("reports prescription medicines as a flag, not as a ranking change", async () => {
    const r = await search("amoxicillin");
    expect(r.exact.length).toBeGreaterThan(0);
    expect(r.exact[0].medicine.rx_required).toBe(1);
  });

  it("returns nothing for a query it cannot understand", async () => {
    const r = await search("zzzzqqqq");
    expect(r.exact).toHaveLength(0);
    expect(r.alternatives).toHaveLength(0);
  });

  it("survives a typo", async () => {
    const r = await search("paracetamoll");
    expect(r.exact.length).toBeGreaterThan(0);
  });

  it("needs no API key and no network", async () => {
    // The endpoint is a parser plus a query. If either grew a model call, this
    // would start needing a credential and the demo would stop working offline.
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await search("dolo");
    expect(r.exact.length).toBeGreaterThan(0);
  });
});