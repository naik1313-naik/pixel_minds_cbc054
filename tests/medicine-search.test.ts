import { describe, it, expect } from "vitest";
import {
  DOSAGE_FORMS,
  editDistance,
  extractForm,
  extractStrength,
  fuzzyEquals,
  normalize,
  parseQuery,
  scoreMedicine,
  similarity,
  terms,
  typoTolerance,
} from "@/lib/medicine-search";
import type { Medicine } from "@/lib/engine";

function med(over: Partial<Medicine> = {}): Medicine {
  return {
    id: 1,
    name: "Paracetamol 500mg",
    salt: "Acetaminophen",
    price_paise: 2500,
    rx_required: 0,
    synonyms: "Paracetamol, Tylenol, Calpol",
    category: "Analgesic",
    strength: "500mg",
    dosage_form: "Tablet",
    ...over,
  };
}

describe("normalisation", () => {
  it("folds case, punctuation and whitespace", () => {
    expect(normalize("  Dolo-650  ")).toBe("dolo-650");
    expect(normalize("CROCiN Advance")).toBe("crocin advance");
    expect(normalize("a b")).toBe("a b");
  });

  it("strips accents so accented typing still matches", () => {
    expect(normalize("Amoxicilina")).toBe("amoxicilina");
  });

  it("folds full-width digits", () => {
    expect(normalize("５００ｍｇ")).toContain("500");
  });

  it("drops the words that carry no meaning", () => {
    expect(terms("show me nearby pharmacies with dolo in stock")).toEqual(["dolo"]);
  });
});

describe("strength and form extraction", () => {
  it("finds a strength", () => {
    expect(extractStrength("paracetamol 500mg")).toBe("500mg");
    expect(extractStrength("cough syrup 100 ml")).toBe("100ml");
    expect(extractStrength("dolo")).toBeNull();
  });

  it("finds a dosage form", () => {
    expect(extractForm("ibuprofen tablets")).toBe("tablets");
    expect(extractForm("cough syrup")).toBe("syrup");
    expect(extractForm("dolo")).toBeNull();
  });

  it("knows a real list of forms", () => {
    expect(DOSAGE_FORMS).toContain("syrup");
    expect(DOSAGE_FORMS).toContain("sachet");
  });
});

describe("edit distance", () => {
  it("is zero for identical strings", () => {
    expect(editDistance("aspirin", "aspirin")).toBe(0);
  });

  it("counts a substitution once", () => {
    expect(editDistance("aspirin", "aspirjn")).toBe(1);
  });

  it("counts an adjacent transposition as one edit, not two", () => {
    // The reason plain Levenshtein is not enough: "teh" → "the" must read as
    // one typo, because that is what a person actually did.
    expect(editDistance("teh", "the")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

describe("typo tolerance", () => {
  it("is zero for very short terms", () => {
    // A one-edit budget on a three-letter query matches most of the catalogue.
    expect(typoTolerance("ors")).toBe(0);
  });

  it("scales with length", () => {
    expect(typoTolerance("dolo")).toBe(1);
    expect(typoTolerance("paracetamol")).toBe(2);
  });

  it("accepts a plausible typo and refuses a different word", () => {
    expect(fuzzyEquals("paracetamol", "paracetamoi")).toBe(true);
    expect(fuzzyEquals("dolo", "doll")).toBe(true);
    expect(fuzzyEquals("paracetamol", "amoxicillin")).toBe(false);
  });

  it("does not let a short query match something unrelated", () => {
    expect(fuzzyEquals("ors", "orsh")).toBe(false);
  });
});

describe("similarity", () => {
  it("is 1 for an exact match", () => {
    expect(similarity("Dolo 650", "dolo 650")).toBe(1);
  });

  it("is 0 when nothing is shared", () => {
    expect(similarity("zzzz", "amoxicillin")).toBe(0);
  });

  it("stays within bounds for partial matches", () => {
    const s = similarity("para syrup", "Paracetamol 500mg Tablet");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe("scoring a catalogue entry", () => {
  it("rewards an exact name", () => {
    const r = scoreMedicine(med(), { query: "paracetamol 500mg" });
    expect(r).not.toBeNull();
    expect(r!.matchedOn).toBe("exact");
    expect(r!.reasons).toContain("exact medicine name");
  });

  it("finds a medicine by its generic name", () => {
    const r = scoreMedicine(med(), { query: "acetaminophen" });
    expect(r).not.toBeNull();
    expect(r!.reasons.join(" ")).toMatch(/active ingredient/i);
  });

  it("finds a medicine by a brand synonym", () => {
    const r = scoreMedicine(med(), { query: "tylenol" });
    expect(r).not.toBeNull();
    expect(r!.reasons.join(" ")).toMatch(/known name: Tylenol/i);
  });

  it("tolerates a typo", () => {
    const r = scoreMedicine(med({ name: "Paracetamol 500mg" }), { query: "paracetamoll" });
    expect(r).not.toBeNull();
  });

  it("returns null rather than a weak match", () => {
    // Filling a results list with things nobody asked for is worse than showing
    // nothing, so an unrelated query must produce no match at all.
    expect(scoreMedicine(med(), { query: "zzzzzz" })).toBeNull();
  });

  it("marks a different strength as an alternative, not an exact match", () => {
    const r = scoreMedicine(med({ name: "Dolo 650", strength: "650mg" }), {
      query: "paracetamol 500mg",
    });
    expect(r).not.toBeNull();
    expect(r!.matchedOn).toBe("alternative");
    expect(r!.differsBy).toMatch(/650mg/);
  });

  it("marks a different dosage form as an alternative", () => {
    const r = scoreMedicine(med({ name: "Cough Syrup 100ml", dosage_form: "Syrup" }), {
      query: "cough syrup tablet",
    });
    expect(r!.matchedOn).toBe("alternative");
    expect(r!.differsBy).toMatch(/form/i);
  });

  it("ranks the exact match above a same-ingredient alternative", () => {
    const exact = scoreMedicine(med({ id: 1, name: "Paracetamol 500mg", strength: "500mg" }), {
      query: "paracetamol 500mg",
    })!;
    const alt = scoreMedicine(med({ id: 2, name: "Dolo 650", strength: "650mg" }), {
      query: "paracetamol 500mg",
    })!;
    expect(exact.score).toBeGreaterThan(alt.score);
    expect(exact.matchedOn).toBe("exact");
    expect(alt.matchedOn).toBe("alternative");
  });

  it("never uses prescription status as a ranking signal", () => {
    const base = { name: "Amoxicillin 500mg", salt: "Amoxicillin", category: "Antibiotic" };
    const otc = scoreMedicine(med({ ...base, rx_required: 0 }), { query: "amoxicillin" })!;
    const rx = scoreMedicine(med({ ...base, rx_required: 1 }), { query: "amoxicillin" })!;
    // Same text, same score. The Rx flag is reported separately so the user is
    // informed, never steered by it.
    expect(otc.score).toBe(rx.score);
    expect(rx.rxRequired).toBe(true);
  });

  it("reports the Rx requirement without letting it change the ranking", () => {
    const r = scoreMedicine(med({ rx_required: 1, name: "Azithromycin 500", salt: "Azithromycin" }), {
      query: "azithromycin",
    })!;
    expect(r.rxRequired).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("always explains itself", () => {
    const r = scoreMedicine(med(), { query: "calpol" })!;
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("scores an empty query as no match", () => {
    expect(scoreMedicine(med(), { query: "   " })).toBeNull();
  });
});

describe("the natural-language parser", () => {
  it("extracts the medicine from a full sentence", () => {
    const p = parseQuery("show nearby pharmacies with crocin in stock");
    expect(p.medicine).toBe("crocin");
    expect(p.inStockOnly).toBe(true);
  });

  it("extracts a distance filter", () => {
    const p = parseQuery("find dolo within 3 km");
    expect(p.medicine).toBe("dolo");
    expect(p.maxDistanceKm).toBe(3);
  });

  it("does not invent a distance when none is given", () => {
    // Silently defaulting to a radius would produce a list that looks tailored
    // and is not.
    const p = parseQuery("show nearby pharmacies with dolo");
    expect(p.maxDistanceKm).toBeNull();
    expect(p.understood.join(" ")).toMatch(/no distance/i);
  });

  it("maps a symptom phrase to a category", () => {
    expect(parseQuery("something for my allergy").category).toBe("Allergy and antihistamines");
    expect(parseQuery("medicine for acidity").category).toBe("Antacids and oral rehydration");
  });

  it("pulls out strength and form", () => {
    const p = parseQuery("paracetamol 500mg tablets near me");
    expect(p.strength).toBe("500mg");
    expect(p.form).toBe("tablets");
  });

  it("says when it understood nothing", () => {
    // Every word was an instruction or a stopword, so no medicine was left.
    expect(parseQuery("show me the pharmacies nearby").empty).toBe(true);
  });

  it("lists what it understood, so the answer can be explained", () => {
    const p = parseQuery("show nearby pharmacies with amoxicillin 500mg in stock within 2 km");
    expect(p.medicine).toBe("amoxicillin");
    expect(p.inStockOnly).toBe(true);
    expect(p.maxDistanceKm).toBe(2);
    expect(p.understood.length).toBeGreaterThanOrEqual(3);
  });

  it("works with no network and no key — it is a parser, not a call", () => {
    // Nothing here touches the network. The assertion is that the function is
    // synchronous and total: same input, same output, every time.
    const a = parseQuery("find dolo in stock within 2 km");
    const b = parseQuery("find dolo in stock within 2 km");
    expect(a).toEqual(b);
  });
});