/**
 * Feature D — the assistant.
 *
 * A deterministic intent router over the application's own authorised services.
 * No model, no API key, no network call, and no route that could leak another
 * patient's information: every handler is handed the caller's own session and
 * answers only from it.
 *
 * ## The one hard boundary
 *
 * Medical questions are answered by `lib/triage.ts`, which asks questions,
 * checks for red flags and gives general comfort measures — and always ends by
 * telling the person to consult a doctor. It never names a diagnosis, a
 * condition, a dose or a duration.
 *
 * That boundary is not a disclaimer bolted on at the end. It is why the triage
 * module exists in the shape it does: it refuses to reach a conclusion, and the
 * router below refuses to route a clinical question to anything that could.
 */
import { queryOne, queryAll } from "./db";
import type { Medicine } from "./engine";
import { triage, matchSymptom, screenForEmergency, EMERGENCY_NUMBER } from "./triage";
import { scoreMedicine, type ScoredMedicine } from "./medicine-search";
import { providerName, rephraseWithProvider } from "./assistant-provider";

export interface AssistantActor {
  userId: number;
  role: string;
  pharmacyId: number | null;
  name: string;
}

export type IntentKind =
  | "greeting"
  | "order_status"
  | "stock_lookup"
  | "tracking_help"
  | "dashboard_help"
  | "assignment_help"
  | "restock_help"
  | "symptom"
  | "medicine_availability"
  | "medical_boundary"
  | "unknown";

export interface CatalogueResult {
  id: number;
  display_name: string;
  generic_name: string;
  brand_name: string | null;
  strength_value: number | null;
  strength_unit: string | null;
  dosage_form: string;
  category: string;
  requires_prescription: boolean;
  verification_status: string;
  price_paise: number;
  pharmacies: { id: number; name: string; free: number; price_paise: number }[];
  nearest_km: number | null;
  matchType: "exact" | "alternative" | "weak";
  differsBy: string | null;
}

export interface AssistantReply {
  intent: IntentKind;
  message: string;
  /** How the UI should present this. Mirrors the API's responseType. */
  responseType: "general-information" | "health-information" | "pharmacy-search" | "emergency-guidance" | "clarifying-question";
  /** Catalogue rows the backend verified. Never invented. */
  catalogue?: CatalogueResult[];
  /** Safety notice text, when one applies. */
  safetyNotice?: string;
  emergencyContact?: string;
  /** "local" or the configured provider model. */
  answeredBy: "local" | "provider" | "local (provider unavailable)";
  /** Why the provider was skipped, when it was. Never shown to end users. */
  providerFallbackReason?: string;
  /** Backend-computed data the UI may render. Never contains another user's data. */
  data?: Record<string, unknown>;
  /** Every reply that touches health ends with a referral. Surfaced so the UI can style it. */
  consultADoctor?: boolean;
  /** Set when the assistant could not answer confidently. */
  unsure?: boolean;
}

/** Signals that a message is about a health problem rather than about the app. */
const MEDICAL_HINTS = [
  "pain", "ache", "fever", "cough", "cold", "headache", "migraine", "stomach",
  "belly", "tummy", "rash", "itch", "urine", "urine", "vomit", "diarrhoea",
  "diarrhea", "loose", "dizzy", "faint", "sore throat", "throat", "burning",
  "infection", "symptom", "disease", "medicine for", "what should i take",
  "bukhar", "khansi", "sardi", "dard", "pet", "peshab", "chakkar", "dast",
  "treatment", "diagnosis", "dose", "how much",
];

function looksMedical(text: string): boolean {
  const t = text.toLowerCase();
  if (MEDICAL_HINTS.some((h) => t.includes(h))) return true;
  return matchSymptom(text) !== null;
}

/** Words that mean the person changed the subject rather than answering us. */
const APP_INTENT =
  /\b(order|delivery|track|status|pharmacy|stock|login|account|password|dashboard|console|payout|invoice)\b/i;

/**
 * Whether this turn continues an existing health conversation.
 *
 * Looking only at the latest message is not enough: the answers to our own
 * questions are "no", "two days", "about 40" — none of which mention a symptom.
 * Without this, a triage conversation dead-ends at the first "no" and the person
 * gets the generic fallback for having continued to answer our questions.
 *
 * The subject-change guard matters as much as the continuation: asking about an
 * order after describing a symptom has to go to the order handler, not back into
 * triage.
 */
function continuesHealthConversation(message: string, history: string[]): boolean {
  if (history.length === 0) return false;
  const shortAnswer = message.trim().split(/\s+/).length <= 4;
  if (!shortAnswer) return false;
  if (APP_INTENT.test(message)) return false;
  return looksMedical(history.join(" "));
}

/**
 * Routes one message.
 *
 * Every handler below takes the actor and reads only through it. There is no
 * handler that takes a "userId" parameter, which is the cheapest way to make an
 * ownership bug impossible rather than merely unlikely.
 */
export async function route(
  message: string,
  actor: AssistantActor,
  history: string[] = []
): Promise<AssistantReply> {
  const text = message.toLowerCase().trim();
  const provider = providerName();

  if (!text) {
    return local({ intent: "unknown", responseType: "general-information", message: "Ask me anything about your orders or the demo.", unsure: true });
  }

  // ---------------------------------------------------------------- 1. emergency
  //
  // Deterministic, first, and independent of anything the provider could say.
  const emergency = screenForEmergency(message);
  if (emergency.triggered) {
    return local({
      intent: "medical_boundary",
      responseType: "emergency-guidance",
      message:
        `${emergency.why}\n\nCall ${EMERGENCY_NUMBER} — the national emergency number in India — or get to ` +
        `the nearest emergency department now. Do not wait for this to settle.\n\n` +
        `⚠️ This is an emergency. Please get professional help immediately.`,
      safetyNotice: "Emergency guidance takes priority over every other intent.",
      emergencyContact: EMERGENCY_NUMBER,
      consultADoctor: true,
      data: { redFlag: emergency.why },
    });
  }

  // ---------------------------------------------------------------- 2. health
  //
  // Before any other intent, so nothing else can accidentally answer a
  // medical question. Includes the continuation case, because the answer to a
  // triage question rarely mentions a symptom.
  if (looksMedical(message) || continuesHealthConversation(message, history)) {
    const result = triage([...history, message]);

    if (result.responseType === "emergency") {
      return local({
        intent: "medical_boundary",
        responseType: "emergency-guidance",
        message: result.message,
        safetyNotice: "One of your answers matched an emergency warning sign.",
        emergencyContact: result.emergencyContact,
        consultADoctor: true,
        data: { redFlags: result.redFlagsFound },
      });
    }

    if (result.responseType === "clarifying-question" || result.responseType === "insufficient-information") {
      return local({
        intent: result.symptom === "unknown" ? "medical_boundary" : "symptom",
        responseType: result.symptom === "unknown" ? "health-information" : "clarifying-question",
        message: result.message,
        consultADoctor: true,
        data: {
          nextQuestion: result.nextQuestion,
          categories: result.browseCategories,
        },
      });
    }

    // Full answer. The provider may reword it; it may never replace the content,
    // and its output is rejected if it introduces a dose, a diagnosis or a
    // number we did not write.
    const reply: Omit<AssistantReply, "answeredBy"> = {
      intent: "symptom",
      responseType: "health-information",
      message: result.message,
      consultADoctor: true,
      safetyNotice:
        "General information only. A doctor or pharmacist has to examine you before anything can be " +
        "called a diagnosis.",
      data: {
        urgency: result.urgency,
        categories: result.browseCategories,
        possibleCauses: result.possibleCauses,
        watchFor: result.watchFor,
      },
    };
    return maybeProvider(reply, message);
  }

  // ---------------------------------------------------------------- 3. greeting
  if (/^(hi|hello|hey|namaste|namaska|good (morning|evening|afternoon))\b/.test(text)) {
    return local({
      intent: "greeting",
      responseType: "general-information",
      message: `Hello ${actor.name.split(" ")[0]}. I can look up stock, check your own orders, explain tracking, or help you find a pharmacy that has something.`,
    });
  }

  // ---------------------------------------------------------------- 4. medicine availability
  //
  // Runs before the generic stock handler, because a named medicine is the more
  // specific question.
  const medicineName = extractMedicineName(message);
  if (medicineName) {
    return medicineAvailability(medicineName);
  }

  // ---------------------------------------------------------------- 5. app data
  if (/(order|delivery|status|kahan|where is|track)/.test(text)) return orderStatus(actor);
  if (/(stock|available|pharmacy|in stock|nearby)/.test(text)) return stockLookup();

  // ---------------------------------------------------------------- 6. how-to
  if (/(track my|how do i track|track the delivery|where is my rider|before seeing a doctor|appointment)/.test(text)) {
    return local({
      intent: "tracking_help",
      responseType: "general-information",
      message: trackingHelp(),
    });
  }

  if (actor.role === "pharmacy_owner" || actor.role === "pharmacy_staff") {
    if (/(dashboard|console|how do i|incoming|prepare|confirm|ready)/.test(text)) {
      return local({
        intent: "dashboard_help",
        responseType: "general-information",
        message:
          "Incoming requests: confirm or reject, then mark Ready — that is what opens stock for pickup or " +
          "creates a delivery job. Inventory is where quantities are adjusted. Payouts shows what is captured, " +
          "what is owed to you, and whether your linked account is active. Batches and Transfers write to the " +
          "blockchain ledger.",
      });
    }
  }

  if (actor.role === "delivery_partner" && /(assignment|offer|job|accept|why me|assigned)/.test(text)) {
    return local({
      intent: "assignment_help",
      responseType: "general-information",
      message:
        "When a pharmacy marks an order Ready, the job is offered to online riders who are free. The offer runs " +
        "for a short window and then moves to the next rider, so it is not first-come-first-served — it goes " +
        "to eligible riders in turn. Accepting sends it to the pharmacy for approval. You are paid the delivery " +
        "fee once the handover is verified with the customer's OTP.",
    });
  }

  if (
    (actor.role === "pharmacy_owner" || actor.role === "pharmacy_staff" || actor.role === "admin") &&
    /(restock|low stock|reorder|forecast|inventory alert)/.test(text)
  ) {
    return restockHelp(actor);
  }

  // ---------------------------------------------------------------- 7. fallback
  return local({
    intent: "unknown",
    responseType: "general-information",
    unsure: true,
    message:
      "I did not follow that. I can look up stock in the catalogue, check your own orders, explain how " +
      "tracking works, or explain the pharmacy and rider consoles. If it is about a health problem I will help " +
      "with general information and point you at a doctor — but I cannot diagnose or prescribe.",
  });
}

// ---------------------------------------------------------------- helpers

function local(reply: Omit<AssistantReply, "answeredBy">): AssistantReply {
  return { ...reply, answeredBy: "local" };
}

/**
 * Optionally lets the provider reword an answer.
 *
 * On any failure the local answer is returned untouched. A slightly plainer
 * answer is a far better outcome than no answer, which is why there is no
 * configuration in which a provider problem reaches the user as an error.
 */
async function maybeProvider(
  reply: Omit<AssistantReply, "answeredBy">,
  question: string
): Promise<AssistantReply> {
  // No provider configured: the local answer is the answer, not a degraded one.
  if (!providerName()) return { ...reply, answeredBy: "local" };
  const result = await rephraseWithProvider(reply.message, question, {
    emergencyContact: reply.emergencyContact,
  });
  if (!result.used || !result.text) {
    return { ...reply, answeredBy: "local (provider unavailable)", providerFallbackReason: result.fallbackReason };
  }
  return { ...reply, message: result.text, answeredBy: "provider" };
}

function trackingHelp(): string {
  return (
    "Open the order from \"My requests\". The tracker shows the rider's location, the OTP prompt and the " +
    "handover steps.\n\n" +
    "**What to prepare before seeing a doctor** — this is the part people find useful:\n" +
    "• When it started, and whether it came on suddenly or gradually\n" +
    "• What makes it better or worse, and anything that reliably triggers it\n" +
    "• Every medicine you take, including ones you buy yourself, and any recent change\n" +
    "• Allergies, and any chronic condition\n" +
    "• If pregnant or breastfeeding, say so early\n" +
    "• Roughly how old the person affected is\n" +
    "• Any tests you already have, or a photo of a rash\n\n" +
    "Bring the medicine packets with you if you can — the label tells a doctor more than the name does."
  );
}

/** Pulls a medicine name out of a question, if one is named. */
function extractMedicineName(message: string): string | null {
  const patterns = [
    /(?:do you have|have you got|is there|availability of|stock of|available)\s+([a-z][a-z0-9 ]{2,30}?)(?:\s+in stock|\s+nearby|\s+available|\?|$)/i,
    /(?:where can i (?:get|buy|find)|where do i (?:get|buy|find))\s+([a-z][a-z0-9 ]{2,30}?)(?:\?|$)/i,
    /(?:nearby pharmacy|near me).{0,20}?with\s+([a-z][a-z0-9 ]{2,30}?)(?:\s+in stock|\?|$)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m) {
      const candidate = m[1].trim().replace(/\s+/g, " ").replace(/\b(?:in|near|at|my|the|a|an|any|some)\b$/i, "");
      if (candidate.length >= 3 && !/^(it|this|that|them|these|those|anything|something)$/i.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Searches the real catalogue and the real inventory.
 *
 * Nothing here invents a product, a price, a quantity or a pharmacy: every
 * field comes from a row that exists at query time, and a match with no stock
 * is reported as no stock.
 */
async function medicineAvailability(name: string): Promise<AssistantReply> {
  const rows = await queryAll<Medicine>(
    `SELECT id, name, salt, rx_required, strength, synonyms, category, dosage_form,
            display_name, generic_name, brand_name, ingredients, strength_value, strength_unit,
            route, subcategory, therapeutic_class, manufacturer, requires_prescription, rx_basis,
            verification_status, package_size, is_active, price_paise
       FROM medicines WHERE is_active = 1 ORDER BY id LIMIT 300`
  );

  const scored = rows
    .map((r) => scoreMedicine(r, { query: name }))
    .filter((hit): hit is ScoredMedicine => hit !== null && hit.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (scored.length === 0) {
    return local({
      intent: "medicine_availability",
      responseType: "pharmacy-search",
      message:
        `I could not find "${name}" in the catalogue. I would rather say that than invent a match — try the ` +
        `generic name rather than a brand, and I will look again.`,
      unsure: true,
      catalogue: [],
    });
  }

  const ids = scored.map((s) => s.medicine.id);
  const stock = await queryAll<{
    medicine_id: number;
    pharmacy_id: number;
    pharmacy_name: string;
    free: number;
    price_paise: number;
    lat: number;
    lng: number;
  }>(
    `SELECT i.medicine_id, p.id AS pharmacy_id, p.name AS pharmacy_name,
            GREATEST(0, i.qty_total - i.qty_locked)::int AS free, i.price_paise, p.lat, p.lng
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE i.medicine_id = ANY($1)
        AND p.verification_status = 'verified'
        AND i.qty_total - i.qty_locked > 0
        AND (i.expiry_date IS NULL OR i.expiry_date >= CURRENT_DATE::text)`,
    [ids]
  );

  const exact: CatalogueResult[] = [];
  const alternatives: CatalogueResult[] = [];

  for (const hit of scored) {
    const mine = stock.filter((s) => s.medicine_id === hit.medicine.id);
    const pharmacies = mine.map((s) => ({
      id: s.pharmacy_id,
      name: s.pharmacy_name,
      free: s.free,
      price_paise: s.price_paise,
    }));
    const entry: CatalogueResult = {
      id: hit.medicine.id,
      display_name: hit.medicine.display_name ?? hit.medicine.name,
      generic_name: hit.medicine.generic_name ?? hit.medicine.name,
      brand_name: hit.medicine.brand_name ?? null,
      strength_value: hit.medicine.strength_value ?? null,
      strength_unit: hit.medicine.strength_unit ?? null,
      dosage_form: hit.medicine.dosage_form ?? "",
      category: hit.medicine.category ?? "",
      requires_prescription: hit.rxRequired,
      verification_status: hit.medicine.verification_status ?? "unverified",
      price_paise: hit.medicine.price_paise,
      pharmacies,
      nearest_km: null,
      matchType: hit.matchedOn === "category" ? "weak" : hit.matchedOn,
      differsBy: hit.differsBy,
    };
    (hit.matchedOn === "alternative" ? alternatives : exact).push(entry);
  }

  const inStock = exact.filter((e) => e.pharmacies.length > 0);
  const lines = inStock.length
    ? inStock.map(
        (e) =>
          `• ${e.display_name} — ${e.pharmacies.reduce((a, p) => a + p.free, 0)} units at ` +
          `${e.pharmacies.length} pharmacy/pharmacies${e.requires_prescription ? " · prescription only" : ""}`
      )
    : ["• Nothing in stock at any pharmacy right now."];

  return local({
    intent: "medicine_availability",
    responseType: "pharmacy-search",
    message:
      `Matches for "${name}" in the catalogue:\n${lines.join("\n")}\n\n` +
      (alternatives.length
        ? `Other strengths or forms of the same ingredient — these are **not** the same medicine and are not ` +
          `substitutes:\n${alternatives.map((a) => `• ${a.display_name} — ${a.differsBy ?? "different presentation"}`).join("\n")}\n\n`
        : "") +
      `Prices shown are fictional demo values. Prescription flags are curated, not taken from a regulatory ` +
      `register — a pharmacist must confirm what you are given.`,
    catalogue: [...exact, ...alternatives],
    safetyNotice:
      "I am not recommending any of these. This is catalogue and inventory information, not advice on what " +
      "you should take.",
    consultADoctor: true,
    unsure: exact.length === 0,
  });
}

/** The caller's own orders, and only those. */
async function orderStatus(actor: AssistantActor): Promise<AssistantReply> {
  if (actor.role === "customer") {
    const rows = await queryAll(
      `SELECT r.id, r.status, r.fulfilment_type, r.created_at, r.payment_status, m.name AS medicine
         FROM requests r LEFT JOIN medicines m ON m.id = r.medicine_id
        WHERE r.customer_id = $1
        ORDER BY r.id DESC LIMIT 5`,
      [actor.userId]
    );
    if (rows.length === 0) {
      return local({
        intent: "order_status",
        responseType: "general-information",
        message: "You have no orders yet. Search a medicine from the catalogue and reserve one.",
        data: { orders: [] },
      });
    }
    const lines = rows.map(
      (r) =>
        `#${r.id} ${r.medicine} — ${r.status}${r.fulfilment_type === "delivery" ? " (delivery)" : ""}` +
        `${r.payment_status ? `, payment ${r.payment_status}` : ""}`
    );
    return local({
      intent: "order_status",
      responseType: "general-information",
      message: `Your most recent orders:\n${lines.map((l) => `• ${l}`).join("\n")}`,
      data: { orders: rows },
    });
  }

  if (actor.role === "pharmacy_owner" || actor.role === "pharmacy_staff") {
    if (!actor.pharmacyId) {
      return local({
        intent: "order_status",
        responseType: "general-information",
        message: "No pharmacy is linked to this account.",
        unsure: true,
      });
    }
    const rows = await queryAll(
      `SELECT r.id, r.status, m.name AS medicine
         FROM requests r LEFT JOIN medicines m ON m.id = r.medicine_id
        WHERE r.preferred_pharmacy_id = $1
        ORDER BY r.id DESC LIMIT 5`,
      [actor.pharmacyId]
    );
    return local({
      intent: "order_status",
      responseType: "general-information",
      message: rows.length
        ? `Your pharmacy's recent requests:\n${rows.map((r) => `• #${r.id} ${r.medicine} — ${r.status}`).join("\n")}`
        : "Your pharmacy has no recent requests.",
      data: { orders: rows },
    });
  }

  const n = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM requests");
  return local({
    intent: "order_status",
    responseType: "general-information",
    message: `${n?.n ?? 0} orders exist in this demo network. Open the Orders tab to see who ordered what, from which pharmacy, with which rider.`,
  });
}

/** Network-wide availability for a named medicine, if there is one. */
async function stockLookup(): Promise<AssistantReply> {
  const meds = await queryAll<{ id: number; name: string; free: number; pharmacies: number }>(
    `SELECT m.id, m.name,
            COALESCE(SUM(GREATEST(0, i.qty_total - i.qty_locked)), 0)::int AS free,
            COUNT(DISTINCT i.pharmacy_id) FILTER (
              WHERE i.qty_total > i.qty_locked
                AND (i.expiry_date IS NULL OR i.expiry_date >= CURRENT_DATE::text))::int AS pharmacies
       FROM medicines m
       LEFT JOIN inventory i ON i.medicine_id = m.id
      WHERE m.is_active = 1
      GROUP BY m.id
     HAVING SUM(GREATEST(0, i.qty_total - i.qty_locked)) > 0
      ORDER BY free DESC
      LIMIT 8`
  );
  const lines = meds.map((m) => `• ${m.name} — ${m.free} units across ${m.pharmacies} pharmacies`);
  return local({
    intent: "stock_lookup",
    responseType: "pharmacy-search",
    message: `Most stock on the network right now:\n${lines.join("\n")}\n\nName a medicine and I will check that one specifically.`,
    data: { medicines: meds },
  });
}

/** Low stock, read from the same inventory the order flow uses. */
async function restockHelp(actor: AssistantActor): Promise<AssistantReply> {
  const rows = await queryAll(
    `SELECT m.name, i.qty_total, i.qty_locked, i.expiry_date,
            GREATEST(0, i.qty_total - i.qty_locked)::int AS free
       FROM inventory i JOIN medicines m ON m.id = i.medicine_id
       JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE p.verification_status = 'verified'
        AND i.qty_total - i.qty_locked <= 5
      ORDER BY free ASC, i.expiry_date NULLS LAST
      LIMIT 10`
  );
  const mine = actor.pharmacyId
    ? await queryAll(
        `SELECT m.name, GREATEST(0, i.qty_total - i.qty_locked)::int AS free, i.expiry_date
           FROM inventory i JOIN medicines m ON m.id = i.medicine_id
          WHERE i.pharmacy_id = $1 AND i.qty_total - i.qty_locked <= 5
          ORDER BY free ASC LIMIT 10`,
        [actor.pharmacyId]
      )
    : rows;

  return local({
    intent: "restock_help",
    responseType: "general-information",
    message:
      mine.length === 0
        ? "Nothing in your stock is low right now (the alert threshold is 5 or fewer free units)."
        : `Items at or below 5 free units:\n${mine
            .map((r) => `• ${r.name} — ${r.free} free${r.expiry_date ? `, expires ${r.expiry_date}` : ""}`)
            .join("\n")}\n\nThe forecast panel projects demand from recorded movement and suggests a reorder quantity with its assumptions shown.`,
    data: { lowStock: mine },
  });
}