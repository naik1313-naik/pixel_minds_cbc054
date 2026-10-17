import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Pool } from "pg";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { parseCsv, validateRecord, importRecords, readRecords } from "@/lib/catalogue-import";

/**
 * The import pipeline.
 *
 * The properties that matter are not "does it insert a row" — it does — but
 * "is it safe to run twice", "does it tell me which row is wrong", and "does it
 * refuse to make claims it cannot support".
 */

function pool() {
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      process.env.SUPABASE_DB_URL ||
      "postgresql://localhost/medimesh",
  });
}

describe("CSV parsing", () => {
  it("reads a header and rows", () => {
    const rows = parseCsv("a,b\n1,2\n3,4");
    expect(rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('name,note\nDolo,"one, two, three"');
    expect(rows[0].note).toBe("one, two, three");
  });

  it("handles escaped quotes", () => {
    const rows = parseCsv('name,note\nX,"say ""hi"""');
    expect(rows[0].note).toBe('say "hi"');
  });

  it("handles a newline inside a quoted field", () => {
    const rows = parseCsv('name,note\nX,"line one\nline two"');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain("line two");
  });

  it("ignores a trailing blank line rather than reporting a bad row", () => {
    expect(parseCsv("a\n1\n")).toHaveLength(1);
  });

  it("lowercases headers so column order and casing do not matter", () => {
    expect(parseCsv("Generic_Name\nx")[0]).toEqual({ generic_name: "x" });
  });
});

describe("validation", () => {
  const valid = {
    generic_name: "Paracetamol",
    dosage_form: "Tablet",
    category: "Pain relief and fever",
    strength_value: "500",
    strength_unit: "mg",
  };

  it("accepts a complete record", () => {
    const { record, errors } = validateRecord(valid, 2);
    expect(record?.generic_name).toBe("Paracetamol");
    expect(errors).toHaveLength(0);
  });

  it("requires a generic name", () => {
    const { record, errors } = validateRecord({ ...valid, generic_name: "" }, 7);
    expect(record).toBeUndefined();
    expect(errors[0]).toMatchObject({ row: 7, field: "generic_name" });
  });

  it("requires a dosage form", () => {
    const { record, errors } = validateRecord({ ...valid, dosage_form: "" }, 7);
    expect(record).toBeUndefined();
    expect(errors.some((e) => e.field === "dosage_form")).toBe(true);
  });

  it("requires a category", () => {
    const { record } = validateRecord({ ...valid, category: "" }, 7);
    expect(record).toBeUndefined();
  });

  it("splits a combined strength like 500mg", () => {
    const { record, errors } = validateRecord(
      { ...valid, strength_value: "500mg", strength_unit: "" },
      2
    );
    expect(record?.strength_value).toBe(500);
    expect(record?.strength_unit).toBe("mg");
    expect(errors).toHaveLength(0);
  });

  it("rejects a strength that is not a number", () => {
    const { errors } = validateRecord({ ...valid, strength_value: "abc" }, 12);
    expect(errors.some((e) => e.field === "strength_value" && e.row === 12)).toBe(true);
  });

  it("complains about a strength with no unit", () => {
    const { errors } = validateRecord({ ...valid, strength_unit: "" }, 2);
    expect(errors.some((e) => e.message.includes("without a unit"))).toBe(true);
  });

  it("reports an unknown unit but keeps the row", () => {
    const { record, errors } = validateRecord(
      { ...valid, strength_value: 5, strength_unit: "furlongs" },
      2
    );
    expect(record).toBeDefined();
    expect(errors.some((e) => e.message.includes("unrecognised unit"))).toBe(true);
  });

  it("reads several spellings of yes and no", () => {
    for (const v of ["yes", "true", "1", "Y"]) {
      expect(validateRecord({ ...valid, requires_prescription: v }, 2).record?.requires_prescription).toBe(true);
    }
    for (const v of ["no", "false", "0", "N"]) {
      expect(validateRecord({ ...valid, requires_prescription: v }, 2).record?.requires_prescription).toBe(false);
    }
  });

  it("rejects a prescription flag that is neither", () => {
    const { errors } = validateRecord({ ...valid, requires_prescription: "maybe" }, 2);
    expect(errors.some((e) => e.field === "requires_prescription")).toBe(true);
  });

  it("rejects a negative price", () => {
    const { errors } = validateRecord({ ...valid, price_paise: "-5" }, 2);
    expect(errors.some((e) => e.field === "price_paise")).toBe(true);
  });

  it("strips thousands separators from numbers", () => {
    expect(validateRecord({ ...valid, price_paise: "1,250" }, 2).record?.price_paise).toBe(1250);
  });

  it("never records the prescription flag as machine-derived", () => {
    // rx_basis is provenance. An import is not a regulatory source, and the
    // column exists so nobody has to guess later where a flag came from.
    const { record } = validateRecord({ ...valid, requires_prescription: true }, 2);
    expect(record?.rx_basis).not.toBe("ai");
    expect(record?.rx_basis).toBe("unverified");
  });
});

describe("importing", () => {
  let p: Pool;

  beforeEach(async () => {
    await resetDemo();
    p = pool();
  });
  afterAll(async () => {
    await p.end();
  });

  const row = (over: Record<string, unknown> = {}) => ({
    generic_name: "Import Test Medicine",
    dosage_form: "Tablet",
    category: "Pain relief and fever",
    strength_value: "250",
    strength_unit: "mg",
    source: "unit-test",
    source_ref: "TEST-1",
    ...over,
  });

  it("writes nothing on a dry run", async () => {
    const result = await importRecords([row()], { pool: p, file: "test.csv", dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.inserted).toBe(1);
    const stored = await queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(stored!.n).toBe(0);
  });

  it("writes on apply", async () => {
    const result = await importRecords([row()], { pool: p, file: "test.csv", dryRun: false });
    expect(result.inserted).toBe(1);
    const stored = await queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(stored!.n).toBe(1);
  });

  it("is safe to run twice: the second run updates instead of duplicating", async () => {
    await importRecords([row()], { pool: p, file: "test.csv", dryRun: false });
    const second = await importRecords([row()], { pool: p, file: "test.csv", dryRun: false });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    const stored = await queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(stored!.n).toBe(1);
  });

  it("keeps strengths apart: 250mg and 500mg are two rows", async () => {
    await importRecords([row({ strength_value: "250" }), row({ strength_value: "500" })], {
      pool: p,
      file: "test.csv",
      dryRun: false,
    });
    const rows = await queryAll<{ strength_value: number }>(
      "SELECT strength_value FROM medicines WHERE generic_name = 'Import Test Medicine' ORDER BY strength_value"
    );
    expect(rows.map((r) => Number(r.strength_value))).toEqual([250, 500]);
  });

  it("keeps a brand separate from the generic", async () => {
    await importRecords([row(), row({ brand_name: "Test Brand" })], {
      pool: p,
      file: "test.csv",
      dryRun: false,
    });
    const rows = await queryAll<{ brand_name: string | null }>(
      "SELECT brand_name FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(rows).toHaveLength(2);
    // null sorts after strings in JS, so compare as a set.
    expect(new Set(rows.map((r) => r.brand_name))).toEqual(new Set([null, "Test Brand"]));
  });

  it("does not delete rows that are absent from the file", async () => {
    const before = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM medicines");
    await importRecords([row()], { pool: p, file: "test.csv", dryRun: false });
    const after = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM medicines");
    // +1 for the new row, and nothing removed. An import is not a sync.
    expect(after!.n).toBe(before!.n + 1);
  });

  it("never lets an import flip a prescription flag", async () => {
    await importRecords([row({ requires_prescription: false })], {
      pool: p,
      file: "test.csv",
      dryRun: false,
    });
    // Someone's spreadsheet says false; the catalogue said false; someone edits
    // it to true after review. A later import must not quietly undo that.
    await queryRunSafe(
      "UPDATE medicines SET requires_prescription = 1, rx_basis = 'regulatory' WHERE generic_name = 'Import Test Medicine'"
    );
    await importRecords([row({ requires_prescription: false })], {
      pool: p,
      file: "test.csv",
      dryRun: false,
    });
    const stored = await queryOne<{ requires_prescription: number }>(
      "SELECT requires_prescription FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(stored!.requires_prescription).toBe(1);
  });

  it("rejects a barcode already claimed inside the same file", async () => {
    const result = await importRecords(
      [row({ barcode: "1111111111111" }), row({ barcode: "1111111111111", strength_value: "500" })],
      { pool: p, file: "test.csv", dryRun: false }
    );
    expect(result.failed).toBe(1);
    expect(result.errors.some((e) => e.field === "barcode")).toBe(true);
  });

  it("reports the row number of every bad record", async () => {
    const result = await importRecords(
      [row(), { dosage_form: "Tablet", category: "Pain relief and fever" }],
      { pool: p, file: "test.csv", dryRun: false }
    );
    // Row 1 is the header, so the second record is row 3.
    expect(result.errors.some((e) => e.row === 3)).toBe(true);
  });

  it("records provenance on every imported row", async () => {
    await importRecords([row()], { pool: p, file: "test.csv", dryRun: false });
    const stored = await queryOne<{ source: string; source_ref: string; verification_status: string }>(
      "SELECT source, source_ref, verification_status FROM medicines WHERE generic_name = 'Import Test Medicine'"
    );
    expect(stored!.source).toBe("unit-test");
    expect(stored!.source_ref).toBe("TEST-1");
    // Imported data is unverified until a person says otherwise.
    expect(stored!.verification_status).toBe("unverified");
  });

  it("handles a batch of a few hundred rows", async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      row({ generic_name: `Bulk Import ${i}`, strength_value: String(i + 1) })
    );
    const result = await importRecords(many, { pool: p, file: "bulk.csv", dryRun: false, batchSize: 50 });
    expect(result.inserted).toBe(300);
    const stored = await queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM medicines WHERE generic_name LIKE 'Bulk Import %'"
    );
    expect(stored!.n).toBe(300);
  });
});

describe("reading files", () => {
  it("reads the sample CSV", () => {
    const rows = readRecords("samples/catalogue-sample.csv");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].generic_name).toBeTruthy();
  });

  it("reads the sample JSON", () => {
    const rows = readRecords("samples/catalogue-sample.json");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses a file type it does not understand", () => {
    // Written to a temp path so the test does not depend on a sample that does
    // not exist; the point is the extension check, not the file.
    const tmp = path.join(os.tmpdir(), `mm-import-test-${process.pid}.txt`);
    fs.writeFileSync(tmp, "nothing here");
    try {
      expect(() => readRecords(tmp)).toThrow(/Unsupported file type/);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

async function queryRunSafe(sql: string) {
  const { queryRun } = await import("@/lib/db");
  await queryRun(sql);
}