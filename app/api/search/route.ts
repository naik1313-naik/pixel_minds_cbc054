import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { listMedicines } from "@/lib/engine";
import { CUSTOMER_LOCATION, haversineKm } from "@/lib/geo";
import {
  parseQuery,
  scoreMedicine,
  type ScoredMedicine,
} from "@/lib/medicine-search";
import { queryAll } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Smart medicine search.
 *
 * Returns matches and — separately — alternatives, each with the reason it
 * surfaced. Availability is read from the inventory row at query time; nothing
 * here assumes a product is in stock.
 *
 * The response also echoes what the query parser understood, so the UI can say
 * what it thinks was asked for. Silently dropping a filter is the fastest way to
 * make a search box feel like it is lying.
 */
export const GET = guard(null, async (_ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get("q") ?? "";
  // Number(null) is 0, not NaN — so an absent parameter would silently become
  // "Null Island" and every distance would come back as ~8650 km. The null check
  // has to come first.
  const latParam = url.searchParams.get("lat");
  const lngParam = url.searchParams.get("lng");
  const lat = Number(latParam);
  const lng = Number(lngParam);
  const origin =
    latParam !== null && lngParam !== null && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : CUSTOMER_LOCATION;
  const parse = parseQuery(raw);

  const catalogue = await listMedicines();

  // Category-only query ("something for my allergy"): no phrase to match on, so
  // the filter stands alone rather than being reported as "nothing found".
  const scored: ScoredMedicine[] = [];
  for (const m of catalogue) {
    if (parse.category && (m.category ?? "") !== parse.category) continue;
    if (!parse.medicine && !parse.category && !parse.strength && !parse.form) continue;

    // A category-only query ("something for my allergy") has no phrase to match
    // on. Scoring it as text would match nothing and report an empty result for
    // a request we did understand, so the category itself carries the match.
    const categoryOnly = !parse.medicine && Boolean(parse.category);
    const hit = categoryOnly
      ? categoryMatch(m, parse.category!)
      : scoreMedicine(m, {
          query: parse.medicine!,
          strength: parse.strength,
          form: parse.form,
        });
    // "weak" means text similarity alone carried it — not a real match, so it is
    // not shown as a result.
    if (hit && hit.matchedOn !== "weak") scored.push(hit);
  }

  scored.sort((a, b) => b.score - a.score);

  const withStock = await attachStock(scored, origin, parse);

  return json({
    query: raw,
    understood: parse.understood,
    interpreted: {
      medicine: parse.medicine,
      category: parse.category,
      strength: parse.strength,
      form: parse.form,
      inStockOnly: parse.inStockOnly,
      maxDistanceKm: parse.maxDistanceKm,
    },
    exact: withStock.filter((r) => r.matchedOn !== "alternative"),
    alternatives: withStock.filter((r) => r.matchedOn === "alternative"),
    counts: {
      exact: withStock.filter((r) => r.matchedOn !== "alternative").length,
      alternatives: withStock.filter((r) => r.matchedOn === "alternative").length,
      inStock: withStock.filter((r) => r.pharmacies.length > 0).length,
    },
  });
});

interface WithPharmacies extends ScoredMedicine {
  pharmacies: {
    id: number;
    name: string;
    address: string;
    lat: number;
    lng: number;
    free: number;
    distance_km: number;
    last_stock_update: string | null;
    reasons: string[];
  }[];
  nearest_km: number | null;
}

/**
 * Joins current inventory to each match.
 *
 * One query for every match rather than one per match: this endpoint sits on the
 * customer's critical path, and a catalogue page with fifteen matches would
 * otherwise be fifteen round trips.
 */
async function attachStock(
  scored: ScoredMedicine[],
  origin: { lat: number; lng: number },
  parse: ReturnType<typeof parseQuery>
): Promise<WithPharmacies[]> {
  const ids = scored.map((s) => s.medicine.id);
  if (ids.length === 0) return [];

  const rows = await queryAll<{
    medicine_id: number;
    pharmacy_id: number;
    pharmacy_name: string;
    address: string;
    lat: number;
    lng: number;
    free: number;
    updated_at: string;
    expiry_date: string | null;
  }>(
    `SELECT i.medicine_id, p.id AS pharmacy_id, p.name AS pharmacy_name, p.address,
            p.lat, p.lng, (i.qty_total - i.qty_locked)::int AS free,
            p.created_at AS updated_at, i.expiry_date
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE i.medicine_id = ANY($1)
        AND p.verification_status = 'verified'
        AND i.qty_total - i.qty_locked > 0
        AND (i.expiry_date IS NULL OR i.expiry_date >= CURRENT_DATE::text)`,
    [ids]
  );

  return scored.map((hit) => {
    const mine = rows.filter((r) => r.medicine_id === hit.medicine.id);
    const pharmacies = mine
      .map((r) => {
        const distance_km = Math.round(haversineKm({ lat: r.lat, lng: r.lng }, origin) * 10) / 10;
        return {
          id: r.pharmacy_id,
          name: r.pharmacy_name,
          address: r.address,
          lat: r.lat,
          lng: r.lng,
          free: r.free,
          distance_km,
          last_stock_update: r.updated_at,
          reasons: reasonsFor({ distance_km, free: r.free, maxDistanceKm: parse.maxDistanceKm }),
        };
      })
      .filter((p) => (parse.maxDistanceKm ? p.distance_km <= parse.maxDistanceKm : true))
      .sort((a, b) => b.free - a.free || a.distance_km - b.distance_km);

    return {
      ...hit,
      pharmacies,
      nearest_km: pharmacies.length ? Math.min(...pharmacies.map((p) => p.distance_km)) : null,
    };
  });
}

/**
 * A match on category alone.
 *
 * Scored low and fixed, because nothing about the text ranked it — the result
 * list must not pretend a category hit is a name match.
 */
function categoryMatch(m: (typeof listMedicines extends () => Promise<infer T> ? T : never)[number], category: string): ScoredMedicine {
  return {
    medicine: m,
    score: 0.2,
    reasons: [`matches category "${category}"`],
    matchedOn: "category",
    differsBy: null,
    rxRequired: Boolean(m.rx_required),
  };
}

/** Why this pharmacy, in the customer's terms. */
function reasonsFor(p: { distance_km: number; free: number; maxDistanceKm: number | null }): string[] {
  const out: string[] = [];
  if (p.free > 0) out.push(`${p.free} in stock right now`);
  out.push(`${p.distance_km} km away`);
  if (p.maxDistanceKm && p.distance_km <= p.maxDistanceKm) {
    out.push(`inside your ${p.maxDistanceKm} km limit`);
  } else if (!p.maxDistanceKm && p.distance_km <= 2) {
    out.push("closest to where you are");
  }
  return out;
}