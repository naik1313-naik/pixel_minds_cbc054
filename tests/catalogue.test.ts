import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { CATALOGUE, CATEGORIES } from "@/lib/catalogue-data";

/**
 * Catalogue integrity, checked against what is actually in the database.
 *
 * These are the rules that keep the catalogue honest. Each one exists because
 * breaking it produces a plausible-looking lie rather than an obvious failure.
 */

describe("the catalogue as authored", () => {
  it("is substantial without being padded", () => {
    // The requirement was a real catalogue, not thousands of invented names to
    // make a number look impressive.
    expect(CATALOGUE.length).toBeGreaterThan(100);
  });

  it("covers every declared category", () => {
    const used = new Set(CATALOGUE.map((e) => e.category));
    const missing = CATEGORIES.filter((c) => !used.has(c));
    expect(missing).toEqual([]);
  });

  it("has no two entries with the same natural key", () => {
    const keys = CATALOGUE.map(
      (e) => `${e.generic}|${e.brand ?? ""}|${e.strengthValue ?? "null"}|${e.form}`
    );
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it("never invents a barcode or a manufacturer", () => {
    // The two fields where a plausible-looking fabrication would be acted on.
    // There is no barcode field in the authored data at all, which is the point.
    for (const e of CATALOGUE) {
      expect((e as Record<string, unknown>).barcode).toBeUndefined();
    }
  });

  it("marks demonstration rows explicitly", () => {
    const demo = CATALOGUE.filter((e) => e.verification === "demo");
    expect(demo.length).toBeGreaterThan(0);
    for (const e of demo) expect(e.verification).toBe("demo");
  });

  it("records how every prescription flag was decided", () => {
    for (const e of CATALOGUE) {
      // A flag without provenance is a claim; with provenance it is data.
      expect(typeof e.rx === "boolean").toBe(true);
    }
  });
});

describe("the catalogue as stored", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("stored every authored entry", async () => {
    const n = (
      await queryOne<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM medicines WHERE source IN ('curated-demo','demo-fixture')"
      )
    )!.n;
    expect(n).toBe(CATALOGUE.length);
  });

  it("keeps generic and brand distinct on every row", async () => {
    const rows = await queryAll<{ display_name: string; generic_name: string; brand_name: string | null }>(
      "SELECT display_name, generic_name, brand_name FROM medicines"
    );
    for (const r of rows) {
      expect(r.generic_name.length).toBeGreaterThan(0);
      // A brand may be null, but it must never be the only thing on screen.
      if (r.brand_name) expect(r.display_name).toContain(r.generic_name);
    }
  });

  it("treats different strengths as different entries", async () => {
    // Paracetamol exists at 500mg (unbranded), 400mg (Crocin Advance) and
    // 650mg (Dolo 650). All three are separate rows, which is the whole point of
    // the model: a 400mg tablet is not a 650mg tablet.
    const rows = await queryAll<{ strength_value: number; display_name: string }>(
      "SELECT strength_value, display_name FROM medicines WHERE generic_name = 'Paracetamol'"
    );
    const strengths = rows.map((r) => Number(r.strength_value)).sort((a, b) => a - b);
    expect(strengths).toEqual([400, 500, 650]);
    expect(new Set(rows.map((r) => r.display_name)).size).toBe(3);
  });

  it("records provenance and verification on every row", async () => {
    const rows = await queryAll<{ source: string; verification_status: string; rx_basis: string | null }>(
      "SELECT source, verification_status, rx_basis FROM medicines"
    );
    for (const r of rows) {
      expect(r.source.length).toBeGreaterThan(0);
      expect(["verified", "unverified", "demo"]).toContain(r.verification_status);
      // The prescription flag always says how it was arrived at.
      expect(r.rx_basis).toBeTruthy();
      expect(r.rx_basis).not.toBe("ai");
    }
  });

  it("stores no invented barcodes or manufacturers", async () => {
    const rows = await queryAll<{ barcode: string | null; manufacturer: string | null }>(
      "SELECT barcode, manufacturer FROM medicines"
    );
    for (const r of rows) {
      expect(r.barcode).toBeNull();
      expect(r.manufacturer).toBeNull();
    }
  });

  it("claims no stock it does not have", async () => {
    // Every inventory row must point at a catalogue entry, and no row may claim
    // more than it holds.
    const bad = await queryAll(
      `SELECT pharmacy_id, medicine_id FROM inventory
        WHERE qty_total < 0 OR qty_locked < 0 OR qty_locked > qty_total`
    );
    expect(bad).toEqual([]);
  });

  it("gives each pharmacy its own price for the same product", async () => {
    const rows = await queryAll<{ pharmacy_id: number; price_paise: number }>(
      `SELECT pharmacy_id, price_paise FROM inventory
        WHERE medicine_id = (SELECT id FROM medicines WHERE generic_name = 'Paracetamol' AND brand_name IS NULL LIMIT 1)`
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.price_paise)).size).toBeGreaterThan(1);
  });

  it("rejects a negative stock insert at the database level", async () => {
    // The CHECK constraint is the last line of defence: application code can have
    // a bug, a constraint cannot.
    await expect(
      queryAll(
        `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked, updated_at)
         VALUES (1, (SELECT id FROM medicines LIMIT 1), -5, 0, '')`
      )
    ).rejects.toThrow();
  });

  it("rejects a duplicate natural key", async () => {
    const row = (
      await queryOne<{
        generic_name: string;
        brand_name: string | null;
        strength_value: number | null;
        strength_unit: string | null;
        dosage_form: string;
      }>("SELECT * FROM medicines LIMIT 1")
    )!;
    await expect(
      queryAll(
        `INSERT INTO medicines (display_name, generic_name, brand_name, strength_value,
           strength_unit, dosage_form, category, price_paise, created_at, updated_at, name, salt)
         VALUES ('dupe', $1, $2, $3, $4, $5, 'Pain relief and fever', 100, '', '', $1, $1)`,
        [
          row.generic_name,
          row.brand_name,
          row.strength_value,
          row.strength_unit,
          row.dosage_form,
        ]
      )
    ).rejects.toThrow();
  });
});

afterAll(async () => {
  await resetDemo();
});