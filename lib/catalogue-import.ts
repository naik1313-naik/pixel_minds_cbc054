/**
 * Catalogue import pipeline.
 *
 * Reads CSV or JSON of medicine records and upserts them into the catalogue.
 * Written for the case where somebody hands you a spreadsheet of 5,000 real
 * products from a regulator's open data and you want them in without breaking
 * anything.
 *
 * Design decisions worth stating, because they are what make an import safe to
 * re-run:
 *
 *  - **Never deletes.** An import adds and updates. A row that disappears from
 *    the source file stays in the catalogue; absence is not a deletion signal,
 *    and treating it as one is how a partial export quietly wipes a catalogue.
 *  - **Idempotent.** The natural key is (generic, brand, strength, unit, form).
 *    Running the same file twice changes nothing the second time.
 *  - **Dry run by default for anything destructive-looking.** `--apply` is
 *    required to write. A typo in a 5,000-row file should cost a review, not a
 *    database.
 *  - **Errors carry row numbers.** "3 rows failed" is useless; "row 412: strength
 *    value 'abc' is not a number" is actionable.
 *  - **Barcode collisions are rejected, not merged.** A barcode identifies one
 *    product; silently reassigning one would make a verification claim about the
 *    wrong item.
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

export interface CatalogueRecord {
  generic_name: string;
  brand_name?: string | null;
  ingredients?: string | null;
  strength_value?: number | string | null;
  strength_unit?: string | null;
  dosage_form: string;
  route?: string | null;
  category: string;
  subcategory?: string | null;
  therapeutic_class?: string | null;
  manufacturer?: string | null;
  requires_prescription?: boolean | string | null;
  rx_basis?: string | null;
  regulatory_status?: string | null;
  verification_status?: string | null;
  source?: string | null;
  source_ref?: string | null;
  package_size?: string | null;
  barcode?: string | null;
  aliases?: string | null;
  description?: string | null;
  price_paise?: number | string | null;
  is_active?: boolean | string | null;
}

export interface RowError {
  /** 1-based, counting the header as row 1 — the number a spreadsheet shows. */
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  file: string;
  dryRun: boolean;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: RowError[];
}

// ---------------------------------------------------------------- validation

const STRENGTH_UNITS = new Set(["mg", "ml", "g", "mcg", "ug", "iu", "%", "ppm", "cm"]);

function asBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Validates and normalises one record.
 *
 * Returns the cleaned record plus every problem found, rather than throwing on
 * the first: an import should report all 400 bad rows in one pass, not make the
 * operator fix them one at a time.
 */
export function validateRecord(
  raw: Record<string, unknown>,
  row: number
): { record?: CatalogueRecord; errors: RowError[] } {
  const errors: RowError[] = [];
  const fail = (field: string, message: string) => errors.push({ row, field, message });

  const generic = String(raw.generic_name ?? "").trim();
  if (!generic) fail("generic_name", "required: the active ingredient cannot be empty");

  const dosageForm = String(raw.dosage_form ?? "").trim();
  if (!dosageForm) fail("dosage_form", "required: a presentation without a dosage form is ambiguous");

  const category = String(raw.category ?? "").trim();
  if (!category) fail("category", "required: every entry needs a category");

  // Strength: both halves must agree. A value with no unit is ambiguous
  // (500 what?), and a unit with no value is meaningless.
  let strengthValue: number | null = null;
  let strengthUnit: string | null = null;
  const rawStrength = raw.strength_value;
  const rawUnit = raw.strength_unit;
  if (rawStrength !== null && rawStrength !== undefined && String(rawStrength).trim() !== "") {
    // A combined "500mg" is common in real spreadsheets, so it is split before
    // being rejected as a non-number. Checking the plain number first made a
    // perfectly good row fail with "20mg is not a number".
    const combined = String(rawStrength).trim().match(/^([\d.]+)\s*([a-z%]+)$/i);
    if (combined) {
      strengthValue = asNumber(combined[1]);
      strengthUnit = combined[2].toLowerCase();
    } else {
      strengthValue = asNumber(rawStrength);
      if (strengthValue === null) {
        fail("strength_value", `"${rawStrength}" is not a number`);
      }
    }
  }
  if (rawUnit !== null && rawUnit !== undefined && String(rawUnit).trim() !== "") {
    // A unit given alongside a combined "500mg" value is redundant; the value
    // already carried one. Trust the explicit column only when the value is a
    // bare number.
    if (!/^\s*[\d.]+\s*[a-z%]+\s*$/i.test(String(rawStrength ?? ""))) {
      strengthUnit = String(rawUnit).trim().toLowerCase();
    }
  }
  if (strengthValue !== null && strengthUnit === null) {
    fail("strength_unit", "a strength value was given without a unit");
  }
  if (strengthUnit && !STRENGTH_UNITS.has(strengthUnit)) {
    // Not fatal — a real dataset will contain a unit this list has never seen.
    // Unrecognised units are reported so a person can decide, not silently kept.
    fail("strength_unit", `unrecognised unit "${strengthUnit}" — stored as-is`);
  }

  const rx = asBoolean(raw.requires_prescription);
  if (rx === null && raw.requires_prescription !== null && raw.requires_prescription !== undefined && raw.requires_prescription !== "") {
    fail("requires_prescription", `"${raw.requires_prescription}" is not a yes/no value`);
  }

  const price = asNumber(raw.price_paise);
  if (price === null && raw.price_paise !== null && raw.price_paise !== undefined && raw.price_paise !== "") {
    fail("price_paise", `"${raw.price_paise}" is not a number`);
  }
  if (price !== null && price < 0) fail("price_paise", "a price cannot be negative");

  const active = asBoolean(raw.is_active);

  const record: CatalogueRecord = {
    generic_name: generic,
    brand_name: str(raw.brand_name),
    ingredients: str(raw.ingredients),
    strength_value: strengthValue,
    strength_unit: strengthUnit,
    dosage_form: dosageForm,
    route: str(raw.route),
    category,
    subcategory: str(raw.subcategory),
    therapeutic_class: str(raw.therapeutic_class),
    manufacturer: str(raw.manufacturer),
    requires_prescription: rx ?? false,
    // Never "ai". The provenance of a regulatory flag has to be a person or a
    // source, and an import pipeline is neither.
    rx_basis: str(raw.rx_basis) ?? (str(raw.regulatory_status) ? "regulatory" : "unverified"),
    regulatory_status: str(raw.regulatory_status),
    verification_status: str(raw.verification_status) ?? "unverified",
    source: str(raw.source) ?? "import",
    source_ref: str(raw.source_ref),
    package_size: str(raw.package_size),
    barcode: str(raw.barcode),
    aliases: str(raw.aliases),
    description: str(raw.description),
    price_paise: price ?? 0,
    is_active: active ?? true,
  };

  const fatal = errors.some((e) => ["generic_name", "dosage_form", "category"].includes(e.field));
  return fatal ? { errors } : { record, errors };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ---------------------------------------------------------------- csv

/**
 * A small RFC-4180 CSV reader.
 *
 * Written rather than pulled in because the only hard part is quoted fields
 * containing separators and newlines, and a dependency for that is not worth
 * carrying in a medical catalogue. Handles quotes, escaped quotes, embedded
 * commas and embedded newlines.
 */
export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  return rows
    // Skip a blank trailing line rather than reporting it as a bad row.
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------------------------------------------------------------- upsert

const UPSERT_SQL = `
INSERT INTO medicines
  (display_name, generic_name, brand_name, ingredients, strength_value, strength_unit,
   dosage_form, route, category, subcategory, therapeutic_class, manufacturer,
   requires_prescription, rx_basis, regulatory_status, verification_status,
   source, source_ref, package_size, barcode, aliases, description,
   price_paise, is_active, name, salt, rx_required, synonyms, strength, created_at, updated_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$1,$2,$13,$21,$25,$26,$26)
ON CONFLICT (LOWER(generic_name), COALESCE(brand_name,''), COALESCE(strength_value::text,''),
              COALESCE(strength_unit,''), COALESCE(dosage_form,''))
DO UPDATE SET
  -- Only descriptive fields are updated. The prescription flag is deliberately
  -- NOT overwritten by an import: flipping a regulatory flag from a spreadsheet
  -- is exactly the kind of thing that should be reviewed by a person.
  route = EXCLUDED.route,
  subcategory = EXCLUDED.subcategory,
  therapeutic_class = EXCLUDED.therapeutic_class,
  manufacturer = COALESCE(EXCLUDED.manufacturer, medicines.manufacturer),
  rx_basis = COALESCE(EXCLUDED.rx_basis, medicines.rx_basis),
  regulatory_status = COALESCE(EXCLUDED.regulatory_status, medicines.regulatory_status),
  verification_status = EXCLUDED.verification_status,
  source = EXCLUDED.source,
  source_ref = EXCLUDED.source_ref,
  package_size = COALESCE(EXCLUDED.package_size, medicines.package_size),
  barcode = COALESCE(EXCLUDED.barcode, medicines.barcode),
  aliases = EXCLUDED.aliases,
  description = COALESCE(EXCLUDED.description, medicines.description),
  price_paise = EXCLUDED.price_paise,
  is_active = EXCLUDED.is_active,
  display_name = EXCLUDED.display_name,
  name = EXCLUDED.display_name,
  synonyms = EXCLUDED.aliases,
  -- $25 rather than EXCLUDED.strength_display: the formatted strength string is
  -- computed from the *normalised* values, not from the raw input, so the legacy
  -- column and the structured columns can never disagree.
  strength = $25,
  updated_at = $26
RETURNING (xmax = 0) AS inserted
`;

function displayNameFor(r: CatalogueRecord): string {
  if (r.brand_name) return r.brand_name;
  const strength = r.strength_value !== null ? `${r.strength_value}${r.strength_unit ?? ""}` : "";
  return `${r.generic_name} ${strength}`.trim();
}

function strengthTextFor(r: CatalogueRecord): string {
  if (r.strength_value === null) return "";
  return `${r.strength_value}${r.strength_unit ?? ""}`;
}

/**
 * Imports parsed records.
 *
 * `dryRun` performs every validation and every conflict check, then writes
 * nothing — so the summary a dry run prints is exactly the summary the real run
 * will produce.
 */
export async function importRecords(
  records: Record<string, unknown>[],
  opts: {
    pool: Pool;
    file: string;
    dryRun?: boolean;
    /** Rows per insert. Bounded so a 50k-row import cannot exhaust the pool. */
    batchSize?: number;
    now?: string;
  }
): Promise<ImportResult> {
  const dryRun = opts.dryRun ?? true;
  const batchSize = Math.min(opts.batchSize ?? 200, 1000);
  const now = opts.now ?? new Date().toISOString();

  const result: ImportResult = {
    file: opts.file,
    dryRun,
    total: records.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const valid: CatalogueRecord[] = [];
  records.forEach((raw, i) => {
    const row = i + 2; // +1 for zero-index, +1 for the header line
    const { record, errors } = validateRecord(raw, row);
    result.errors.push(...errors);
    if (!record) {
      result.failed++;
      return;
    }
    valid.push(record);
  });

  // Barcode collisions *within the file* are caught before the database sees
  // them: two rows claiming the same barcode is a data error, not a merge.
  const barcodeOwners = new Map<string, number>();
  const usable: CatalogueRecord[] = [];
  valid.forEach((r, i) => {
    if (!r.barcode) {
      usable.push(r);
      return;
    }
    const owner = barcodeOwners.get(r.barcode);
    if (owner !== undefined) {
      result.errors.push({
        row: i + 2,
        field: "barcode",
        message: `barcode ${r.barcode} is already used by an earlier row in this file`,
      });
      result.failed++;
      return;
    }
    barcodeOwners.set(r.barcode, i + 2);
    usable.push(r);
  });

  if (dryRun) {
    // Still count what would happen, without writing. The upsert returns whether
    // each row was an insert, so a dry run against the real database can answer
    // "how many of these are new?" honestly.
    const client = await opts.pool.connect();
    try {
      for (let i = 0; i < usable.length; i += batchSize) {
        const slice = usable.slice(i, i + batchSize);
        for (const r of slice) {
          const inserted = await wouldInsert(client, r);
          if (inserted) result.inserted++;
          else result.updated++;
        }
      }
    } finally {
      client.release();
    }
    return result;
  }

  const client = await opts.pool.connect();
  try {
    for (let i = 0; i < usable.length; i += batchSize) {
      const slice = usable.slice(i, i + batchSize);
      for (const r of slice) {
        try {
          const res = await client.query(UPSERT_SQL, [
            displayNameFor(r),
            r.generic_name,
            r.brand_name,
            r.ingredients,
            r.strength_value,
            r.strength_unit,
            r.dosage_form,
            r.route,
            r.category,
            r.subcategory,
            r.therapeutic_class,
            r.manufacturer,
            r.requires_prescription ? 1 : 0,
            r.rx_basis,
            r.regulatory_status,
            r.verification_status,
            r.source,
            r.source_ref,
            r.package_size,
            r.barcode,
            r.aliases,
            r.description,
            r.price_paise,
            r.is_active ? 1 : 0,
            strengthTextFor(r),
            now,
          ]);
          if (res.rows[0]?.inserted) result.inserted++;
          else result.updated++;
        } catch (e) {
          result.failed++;
          result.errors.push({
            row: i + 2,
            field: "row",
            message: e instanceof Error ? e.message.slice(0, 300) : "database error",
          });
        }
      }
    }
  } finally {
    client.release();
  }
  return result;
}

async function wouldInsert(
  client: Pool | { query: Pool["query"] },
  r: CatalogueRecord
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM medicines
      WHERE LOWER(generic_name) = LOWER($1)
        AND COALESCE(brand_name,'') = COALESCE($2,'')
        AND COALESCE(strength_value::text,'') = COALESCE($3,'')
        AND COALESCE(strength_unit,'') = COALESCE($4,'')
        AND COALESCE(dosage_form,'') = COALESCE($5,'')
      LIMIT 1`,
    [r.generic_name, r.brand_name, r.strength_value?.toString() ?? "", r.strength_unit, r.dosage_form]
  );
  return res.rowCount === 0;
}

/** Reads a file, dispatching on extension. */
export function readRecords(file: string): Record<string, unknown>[] {
  const ext = path.extname(file).toLowerCase();
  const text = fs.readFileSync(file, "utf8");
  if (ext === ".csv") return parseCsv(text);
  if (ext === ".json") {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.records;
    if (!Array.isArray(rows)) {
      throw new Error("JSON must be an array of records, or an object with a `records` array");
    }
    return rows;
  }
  throw new Error(`Unsupported file type: ${ext}. Use .csv or .json`);
}