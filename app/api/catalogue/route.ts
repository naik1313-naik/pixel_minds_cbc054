import type { NextRequest } from "next/server";
import { json } from "@/lib/api-utils";
import { queryAll, queryOne } from "@/lib/db";

export const runtime = "nodejs";

/**
 * The catalogue browse endpoint.
 *
 * Separate from /api/search, which ranks *matches* to a query. This one answers
 * "show me the catalogue", with filters and pagination — because a customer
 * looking for their blood-pressure tablets does not know the brand name, and
 * forcing them through a fuzzy search to reach a category is a worse interface
 * than being able to browse.
 *
 * Availability is always joined in from `inventory` at query time. A catalogue
 * entry saying a product exists says nothing about whether any pharmacy stocks
 * it, and this endpoint is the place that mistake would be easiest to make.
 */

const SORTS = {
  relevance: "in_stock DESC, generic_name ASC",
  name: "generic_name ASC",
  brand: "COALESCE(brand_name, generic_name) ASC",
  price_asc: "m.price_paise ASC, m.generic_name ASC",
  price_desc: "m.price_paise DESC, m.generic_name ASC",
  stock: "in_stock DESC, m.generic_name ASC",
} as const;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const param = (k: string) => url.searchParams.get(k);

  const category = param("category");
  const subcategory = param("subcategory");
  const form = param("form");
  const route = param("route");
  const unit = param("unit");
  const strength = param("strength"); // exact numeric match, e.g. "500"
  const rx = param("rx"); // "true" | "false"
  const brand = param("brand"); // only branded products
  const q = param("q")?.trim();
  const inStock = param("inStock") === "true";
  const limit = Math.min(Math.max(Number(param("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(param("offset") ?? 0) || 0, 0);
  const sortKey = (param("sort") ?? "relevance") as keyof typeof SORTS;
  const orderBy = SORTS[sortKey] ?? SORTS.relevance;

  const where: string[] = ["m.is_active = 1"];
  const args: unknown[] = [];

  const add = (sql: string, value: unknown) => {
    args.push(value);
    where.push(sql.replace("?", `$${args.length}`));
  };

  if (category) add("m.category = ?", category);
  if (subcategory) add("m.subcategory = ?", subcategory);
  if (form) add("m.dosage_form = ?", form);
  if (route) add("m.route = ?", route);
  if (unit) add("m.strength_unit = ?", unit);
  if (strength) add("m.strength_value::text = ?", strength);
  if (brand === "true") where.push("m.brand_name IS NOT NULL");
  // Prescription status is filterable but never inferred: the column is
  // catalogue data, and the filter reads it rather than deciding it.
  if (rx === "true") where.push("m.requires_prescription = 1");
  if (rx === "false") where.push("m.requires_prescription = 0");
  if (inStock) {
    where.push(
      `EXISTS (
         SELECT 1 FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
          WHERE i.medicine_id = m.id AND p.verification_status = 'verified'
            AND i.qty_total - i.qty_locked > 0
            AND (i.expiry_date IS NULL OR i.expiry_date >= CURRENT_DATE::text))`
    );
  }
  if (q) {
    args.push(`%${q.toLowerCase()}%`);
    const like = `$${args.length}`;
    where.push(
      `(LOWER(m.generic_name) LIKE ${like} OR LOWER(COALESCE(m.brand_name,'')) LIKE ${like}
        OR LOWER(m.aliases) LIKE ${like} OR LOWER(m.ingredients) LIKE ${like})`
    );
  }

  const whereSql = where.join(" AND ");

  const totals = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM medicines m WHERE ${whereSql}`,
    args
  );

  const rows = await queryAll(
    `SELECT m.id, m.display_name, m.generic_name, m.brand_name, m.ingredients,
            m.strength_value, m.strength_unit, m.dosage_form, m.route,
            m.category, m.subcategory, m.therapeutic_class, m.manufacturer,
            m.requires_prescription, m.rx_basis, m.verification_status,
            m.source, m.package_size, m.price_paise,
            COALESCE(stock.in_stock, 0) AS in_stock,
            COALESCE(stock.pharmacies, 0) AS pharmacy_count,
            stock.min_price_paise
       FROM medicines m
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT i.pharmacy_id)::int AS pharmacies,
                SUM(GREATEST(0, i.qty_total - i.qty_locked))::int AS in_stock,
                MIN(NULLIF(i.price_paise, 0))::int AS min_price_paise
           FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
          WHERE i.medicine_id = m.id AND p.verification_status = 'verified'
            AND (i.expiry_date IS NULL OR i.expiry_date >= CURRENT_DATE::text)
       ) stock ON TRUE
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`,
    args
  );

  // The filter vocabulary is derived from the catalogue itself, so adding a
  // category needs no code change anywhere.
  const facets = await queryAll<{ facet: string; values: string[] }>(
    `SELECT 'category' AS facet, array_agg(DISTINCT category ORDER BY category) AS values
       FROM medicines WHERE is_active = 1
     UNION ALL
     SELECT 'form', array_agg(DISTINCT dosage_form ORDER BY dosage_form)
       FROM medicines WHERE is_active = 1
     UNION ALL
     SELECT 'route', array_agg(DISTINCT route ORDER BY route)
       FROM medicines WHERE is_active = 1 AND route IS NOT NULL
     UNION ALL
     SELECT 'subcategory', array_agg(DISTINCT subcategory ORDER BY subcategory)
       FROM medicines WHERE is_active = 1 AND subcategory IS NOT NULL
     UNION ALL
     SELECT 'unit', array_agg(DISTINCT strength_unit ORDER BY strength_unit)
       FROM medicines WHERE is_active = 1 AND strength_unit IS NOT NULL`
  );

  const total = totals?.total ?? 0;
  return json({
    medicines: rows,
    pagination: {
      total,
      limit,
      offset,
      returned: rows.length,
      hasMore: offset + rows.length < total,
      pages: Math.ceil(total / limit),
    },
    facets: Object.fromEntries(facets.map((f) => [f.facet, f.values])),
    note:
      "Prices are fictional demo values. Prescription flags are curated, not taken from a " +
      "regulatory register. Availability comes from live inventory rows, not from this catalogue.",
  });
}