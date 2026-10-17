/**
 * Feature A — medicine search that explains itself.
 *
 * No model, no API key, no embedding service. Everything here is ordinary string
 * arithmetic, and that is the point: the ranking has to be reproducible and
 * arguable, because a customer who is told "this pharmacy was recommended" is
 * entitled to ask why.
 *
 * The design rules, each of which exists because breaking it produces a worse
 * outcome than showing nothing:
 *
 *  1. **Availability is never inferred.** A medicine is reported as in stock
 *     only when the current inventory row says so, at query time. Nothing here
 *     guesses.
 *  2. **Prescription status is never a ranking signal.** A customer must not be
 *     walked towards a cheaper option because it needs a prescription — that is
 *     a clinical constraint, not a preference. Rx is surfaced as a flag.
 *  3. **Strength and dosage form are not interchangeable.** A 500mg tablet is
 *     not an alternative to a 650mg tablet; conflating them would let someone
 *     take the wrong dose. Alternatives go in a separate bucket with the
 *     difference spelled out, never merged into the main list.
 *  4. **Every result carries its reasons.** "Exact name match", "8 units in
 *     stock", "1.2 km away" — the score is not a black box.
 */
import type { Medicine } from "./engine";
import { haversineKm } from "./geo";

// ---------------------------------------------------------------- normalisation

/** Words that carry no meaning when matching a product name. */
const STOPWORDS = new Set([
  "show", "me", "find", "search", "near", "nearby", "nearby", "pharmacy", "pharmacies",
  "with", "have", "has", "stock", "available", "availability", "in", "at", "of", "the",
  "a", "an", "please", "give", "list", "all", "any", "medicine", "medicines", "med", "drug",
  "drugs", "tablet", "tablets", "tab", "capsule", "capsules", "syrup", "strip", "order",
  "buy", "get", "where", "which", "what", "is", "are", "do", "you", "have", "i", "want",
  "need", "and", "or", "for", "to", "my", "near", "closest", "best", "cheapest",
  // Filler that carries no product identity: without these, "something for my
  // allergy" is scored as a search for the medicine called "something".
  "something", "anything", "some", "thing", "stuff",
]);

/**
 * Lowercases, strips punctuation and collapses whitespace.
 *
 * Also folds the handful of unicode look-alikes that otherwise make an exact
 * comparison fail for reasons a human would call absurd — a full-width digit, a
 * non-breaking hyphen, an accented vowel typed on the wrong keyboard.
 */
export function normalize(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/[‐-―−]/g, "-") // every dash -> hyphen
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)) // full-width digits
    .replace(/[^a-z0-9\s.%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pulls a strength like "500mg" out of free text, if one is present. */
export function extractStrength(input: string): string | null {
  const m = normalize(input).match(/\b(\d+(?:\.\d+)?)\s*(mg|ml|g|mcg|iu|%)\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

/** Pulls a dosage form out of free text, if one is named. */
export function extractForm(input: string): string | null {
  const n = normalize(input);
  for (const form of DOSAGE_FORMS) {
    if (new RegExp(`\\b${form}\\b`).test(n)) return form;
  }
  return null;
}

export const DOSAGE_FORMS = [
  "tablet", "tablets", "capsule", "capsules", "syrup", "sachet", "gel", "liquid",
  "lozenge", "drops", "cream", "ointment", "injection",
] as const;

/** Meaningful search terms: stopwords and bare dose words removed. */
export function terms(input: string): string[] {
  return normalize(input)
    .split(" ")
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------- fuzzy match

/**
 * Levenshtein distance with adjacent transposition counted as one edit.
 *
 * Plain Levenshtein charges two for "teh" → "the", which puts ordinary typos
 * outside the tolerance people expect from a search box. Damerau fixes that.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prevPrev: number[] = [];
  let prev: number[] = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    const cur = [i, ...Array<number>(bl).fill(0)];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prevPrev[j - 2] + 1);
      }
    }
    prevPrev = prev;
    prev = cur;
  }
  return prev[bl];
}

/**
 * How many typos to forgive for a term of this length.
 *
 * Scaled by length on purpose: one edit on "aspirin" is a plausible typo, while
 * one edit on "ors" turns it into something else entirely. A fixed tolerance
 * would let a three-letter query match almost anything.
 */
export function typoTolerance(term: string): number {
  if (term.length <= 3) return 0;
  if (term.length <= 5) return 1;
  return 2;
}

/** True when `term` matches `candidate` exactly or within its typo budget. */
export function fuzzyEquals(term: string, candidate: string): boolean {
  if (term === candidate) return true;
  const budget = typoTolerance(term);
  if (budget === 0) return false;
  // Length difference alone can exceed the budget; cheap pre-check.
  if (Math.abs(term.length - candidate.length) > budget) return false;
  return editDistance(term, candidate) <= budget;
}

/**
 * True when a query fragment names a catalogue word.
 *
 * Prefix matching is included because people type fragments, not whole words:
 * "para" is how someone starts typing "paracetamol", and an edit-distance-only
 * comparison scores it at zero because the length gap exceeds the typo budget.
 * Requiring at least three characters keeps "am" from matching "amoxicillin"
 * and half the catalogue.
 */
export function tokenMatches(term: string, candidate: string): boolean {
  if (term === candidate) return true;
  if (term.length >= 3 && candidate.startsWith(term)) return true;
  if (candidate.length >= 3 && term.startsWith(candidate)) return true;
  return fuzzyEquals(term, candidate);
}

/**
 * Similarity in [0,1], combining token overlap and character distance.
 *
 * Averaging the two rather than taking the max: token overlap alone rates
 * "para syrup" as a poor match for "Paracetamol 500mg Tablet" only because of
 * the noise words, while raw edit distance alone cannot see that a long name
 * still matched on its distinctive token.
 */
export function similarity(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;

  const qt = new Set(terms(q));
  const ct = new Set(terms(c));
  if (qt.size === 0) return 0;
  let overlap = 0;
  for (const t of qt) {
    if (ct.has(t)) overlap++;
    else if ([...ct].some((w) => tokenMatches(t, w))) overlap += 0.7;
  }
  const tokenScore = overlap / qt.size;

  const shorter = q.length <= c.length ? q : c;
  const longer = q.length <= c.length ? c : q;
  const charScore = Math.max(0, 1 - editDistance(shorter, longer) / longer.length);

  // Rounded to three decimals so results are stable and readable. Note the
  // divisor: `Math.round(x) / 1` is an integer round, which turned a genuine
  // 0.50 match into a perfect 1.0 — i.e. "exact" for something that was merely
  // close. Anything scoring above 0.5 has to stay visibly below it.
  return Math.round((Math.min(tokenScore, 1) * 0.6 + charScore * 0.4) * 1000) / 1000;
}

// ---------------------------------------------------------------- scoring

/** Weights, in one place so a ranking can be argued with rather than guessed at. */
export const SEARCH_WEIGHTS = {
  exactName: 0.3,
  synonym: 0.2,
  genericSalt: 0.15,
  strength: 0.1,
  form: 0.05,
  text: 0.1,
  stock: 0.05,
  distance: 0.05,
} as const;

export interface ScoredMedicine {
  medicine: Medicine;
  score: number;
  /** Human-readable contributions, strongest first. */
  reasons: string[];
  matchedOn: "exact" | "alternative" | "weak" | "category";
  /** Present when this is a different strength or form of the same substance. */
  differsBy: string | null;
  rxRequired: boolean;
}

export interface ScoreInput {
  query: string;
  /** Force a strength/form match rather than inferring it from the query. */
  strength?: string | null;
  form?: string | null;
}

/**
 * Scores one catalogue entry against a query.
 *
 * Returns null when the entry is not a match at all — a weak match is worse than
 * no match, because it fills a results list with things the customer did not ask
 * for.
 */
export function scoreMedicine(m: Medicine, input: ScoreInput): ScoredMedicine | null {
  const q = normalize(input.query);
  if (!q) return null;

  const nameN = normalize(m.name);
  const saltN = normalize(m.salt ?? "");
  const synonyms = (m.synonyms ?? "")
    .split(",")
    .map((s) => normalize(s))
    .filter(Boolean);
  // The medicine's own strength/form, kept strictly separate from the query's.
  // These used to fall back to the query value, which made every candidate look
  // like it matched the strength that was asked for — so "paracetamol 500mg"
  // ranked a 400mg tablet as a full match, reason and all.
  const medicineStrength = normalize(m.strength ?? "");
  const medicineForm = normalize(m.dosage_form ?? "");
  const qStrength = normalize(input.strength ?? extractStrength(input.query) ?? "");
  const qForm = normalize(input.form ?? extractForm(input.query) ?? "");

  const reasons: string[] = [];
  let score = 0;

  // A query can be several words ("paracetamol 500mg tablets"), so matching works
  // term-wise against each field as well as on the whole string. Whole-string
  // comparison alone would miss "paracetamol 500mg" against a product whose name
  // is "Dolo 650" but whose generic is Acetaminophen.
  const qWords = terms(input.query);
  const hits = (field: string): boolean =>
    qWords.some((w) => tokenMatches(w, field)) || (q.length > 0 && tokenMatches(q, field));
  const exactNameHit = q === nameN;

  // 1. Exact / near-exact name.
  if (exactNameHit) {
    score += SEARCH_WEIGHTS.exactName;
    reasons.push("exact medicine name");
  } else if (fuzzyEquals(q, nameN) || (hits(nameN) && qWords.length > 0)) {
    score += SEARCH_WEIGHTS.exactName * 0.8;
    reasons.push("matches the medicine name");
  }

  // 2. Approved synonym or brand.
  const synonymHit = synonyms.find((s) => s === q || fuzzyEquals(q, s) || (hits(s) && qWords.length > 0));
  if (synonymHit) {
    score += SEARCH_WEIGHTS.synonym;
    const original = (m.synonyms ?? "").split(",").find((s) => normalize(s) === synonymHit);
    reasons.push(original ? `known name: ${original.trim()}` : "known alternative name");
  }

  // 3. Generic / salt. The strongest signal after the name, and how "ORS" or
  //    "paracetamol" find a branded product. Only the query side is compared —
  //    testing the salt against the product's own synonym list would match every
  //    catalogue entry, because each one lists its own generic there, and the
  //    whole catalogue would come back for every search.
  const saltHit = saltN === q || fuzzyEquals(q, saltN) || hits(saltN);
  if (saltHit) {
    score += SEARCH_WEIGHTS.genericSalt;
    reasons.push(`same active ingredient (${m.salt})`);
  }

  // 4 & 5. Strength and dosage form.
  //
  // These only ever *reinforce* a match. On their own they mean nothing — half
  // the catalogue is "500mg Tablet" — so a strength/form hit without a name,
  // generic or synonym relationship contributes no score and no reason. Without
  // that gate, "paracetamol 500mg tablets" returned every 500mg tablet in the
  // pharmacy as a legitimate result.
  const sameIngredient =
    saltN === q ||
    fuzzyEquals(q, saltN) ||
    hits(saltN) ||
    synonymHit !== undefined ||
    exactNameHit ||
    hits(nameN);

  const strengthKnown = Boolean(medicineStrength);
  if (qStrength && strengthKnown && sameIngredient) {
    if (qStrength === medicineStrength) {
      score += SEARCH_WEIGHTS.strength;
      reasons.push(`strength ${m.strength} as asked for`);
    }
  }

  const formKnown = Boolean(medicineForm);
  if (qForm && formKnown && sameIngredient) {
    const formsMatch =
      qForm === medicineForm ||
      qForm === `${medicineForm}s` ||
      `${qForm}s` === medicineForm;
    if (formsMatch) {
      score += SEARCH_WEIGHTS.form;
      reasons.push(`${m.dosage_form}`);
    }
  }

  // 6. General text similarity.
  const sim = similarity(input.query, `${m.name} ${m.salt} ${(m.synonyms ?? "").replace(/,/g, " ")}`);
  score += SEARCH_WEIGHTS.text * sim;
  if (sim >= 0.5 && !reasons.length) reasons.push(`similar to "${m.name}"`);

  // No decisive signal at all: not a match.
  const decisive = score - SEARCH_WEIGHTS.text * sim;
  if (decisive <= 0) return null;

  // Which bucket? A same-ingredient entry that differs in strength or form is an
  // *alternative*, and mixing it into the exact list is how people end up taking
  // the wrong dose.
  let matchedOn: ScoredMedicine["matchedOn"] = "weak";
  let differsBy: string | null = null;
  if (sameIngredient) {
    const differences: string[] = [];
    if (qStrength && strengthKnown && qStrength !== medicineStrength) {
      differences.push(`strength ${m.strength}`);
    }
    if (
      qForm &&
      formKnown &&
      qForm !== medicineForm &&
      `${qForm}s` !== medicineForm &&
      `${medicineForm}s` !== qForm
    ) {
      differences.push(`${m.dosage_form} form`);
    }
    if (differences.length) {
      matchedOn = "alternative";
      differsBy = differences.join(", ");
      // Not a defect in the entry, so it is not penalised — but it must not
      // outrank what was actually asked for.
      score *= 0.85;
    } else {
      matchedOn = "exact";
    }
  }

  // Prescription status is reported, never scored. A customer must not be
  // steered towards an Rx option because it scores well.
  const rxRequired = Boolean(m.rx_required);

  return {
    medicine: m,
    score: Math.round(score * 10000) / 10000,
    reasons,
    matchedOn,
    differsBy,
    rxRequired,
  };
}

// ---------------------------------------------------------------- natural language

export interface ParsedQuery {
  /** The medicine phrase, stripped of instructions. */
  medicine: string | null;
  strength: string | null;
  form: string | null;
  category: string | null;
  /** "in_stock" keeps only pharmacies with free units; null = no filter. */
  inStockOnly: boolean;
  maxDistanceKm: number | null;
  /** Phrases the parser consumed, echoed so the UI can explain itself. */
  understood: string[];
  /** True when nothing recognisable was found. */
  empty: boolean;
}

/**
 * Symptom or intent phrase -> catalogue category.
 *
 * These are *categories*, which is all this is allowed to be. The parser never
 * infers a medicine from a symptom, because that would be making a clinical
 * judgement in a search box.
 */
const CATEGORY_HINTS: Record<string, string> = {
  pain: "Pain relief and fever",
  painkiller: "Pain relief and fever",
  analgesic: "Pain relief and fever",
  fever: "Pain relief and fever",
  antibiotic: "Antibiotics and antimicrobials",
  allergy: "Allergy and antihistamines",
  antihistamine: "Allergy and antihistamines",
  sugar: "Diabetes medicines",
  diabetes: "Diabetes medicines",
  bp: "Blood pressure and cardiovascular",
  bloodpressure: "Blood pressure and cardiovascular",
  hypertension: "Blood pressure and cardiovascular",
  cholesterol: "Cholesterol medicines",
  thyroid: "Thyroid medicines",
  vitamin: "Vitamins and minerals",
  dehydration: "Antacids and oral rehydration",
  acidity: "Antacids and oral rehydration",
  gastritis: "Antacids and oral rehydration",
  acidityreflux: "Gastrointestinal and acidity",
  vomiting: "Gastrointestinal and acidity",
  nausea: "Gastrointestinal and acidity",
  cough: "Cold, cough and respiratory",
  cold: "Cold, cough and respiratory",
  asthma: "Asthma and respiratory inhalers",
  inhaler: "Asthma and respiratory inhalers",
  anxiety: "Mental health medicines",
  depression: "Mental health medicines",
  antifungal: "Antifungal and antiviral",
  worms: "Antiparasitic medicines",
  skincare: "Dermatology and skin care",
  skin: "Dermatology and skin care",
  eye: "Eye drops and ophthalmic",
  ear: "Ear drops and otic",
  dental: "Oral and dental care",
  tooth: "Oral and dental care",
  joint: "Bone, joint and muscle",
  bone: "Bone, joint and muscle",
  kidney: "Kidney and urinary health",
  liver: "Liver and digestive health",
  firstaid: "First aid and antiseptics",
  antiseptic: "First aid and antiseptics",
  wound: "Wound care and dressings",
  bandage: "Wound care and dressings",
  injection: "Injections and infusions",
  nasal: "Nasal sprays and drops",
  syrup: "Oral liquids and syrups",
  tablet: "Tablets and capsules",
  emergency: "Emergency care",
  device: "Devices, diagnostics and essentials",
};

/**
 * Turns a sentence into a structured query.
 *
 * Deliberately a parser, not a model: "show nearby pharmacies with crocin in
 * stock within 3 km" has to work with the network unplugged, which rules out
 * anything that needs an API key.
 */
export function parseQuery(raw: string): ParsedQuery {
  const original = normalize(raw);
  let text = ` ${original} `;
  const understood: string[] = [];

  // Distance filter, e.g. "within 3 km" / "under 2km" / "near me".
  let maxDistanceKm: number | null = null;
  const within = text.match(/\b(?:within|under|less than|below|near me|close to me)\s*(\d+(?:\.\d+)?)\s*km\b/);
  if (within) {
    maxDistanceKm = Number(within[1]);
    text = text.replace(within[0], " ");
    understood.push(`within ${maxDistanceKm} km`);
  } else if (/\bnear me\b|\bclose to me\b|\bnearby\b/.test(text)) {
    // No number given. This is not filtered away: silently inventing a radius
    // would return a list that looks tailored and is not.
    understood.push("no distance filter (no distance was given)");
  }

  let inStockOnly = false;
  if (/\bin stock\b|\bavailable\b|\bhave (?:it|this|any)\b|\bwith stock\b/.test(text)) {
    inStockOnly = true;
    text = text.replace(/\bin stock\b|\bavailable\b|\bwith stock\b|\bhave (?:it|this|any)\b/g, " ");
    understood.push("in-stock pharmacies only");
  }

  // Category hint, e.g. "something for my allergy".
  let category: string | null = null;
  for (const [hint, value] of Object.entries(CATEGORY_HINTS)) {
    const re = new RegExp(`\\bfor (?:my |a |an |the )?${hint}\\b|\\b${hint} (?:medicine|tablet|drugs?)\\b`);
    if (re.test(text)) {
      category = value;
      text = text.replace(re, " ");
      understood.push(`category: ${value}`);
      break;
    }
  }

  const strength = extractStrength(raw);
  const form = extractForm(raw);

  // Remove the dose and form from the phrase: they are already captured, and
  // leaving "500mg" in the medicine text stops it matching a product's name.
  if (strength) text = text.replace(new RegExp(`\\b${strength.replace(/(\d)/g, "$1\\s*")}\\b`), " ");
  if (form) text = text.replace(new RegExp(`\\b${form}\\b`), " ");

  const medicine = terms(text).join(" ") || null;
  const empty = !medicine && !category && !strength && !form;
  if (medicine) understood.push(`medicine: "${medicine}"`);
  if (strength) understood.push(`strength: ${strength}`);
  if (form) understood.push(`form: ${form}`);

  return { medicine, strength, form, category, inStockOnly, maxDistanceKm, understood, empty };
}