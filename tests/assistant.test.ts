import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resetDemo, queryOne } from "@/lib/db";
import {
  triage,
  findUnhedgedClaim,
  screenForEmergency,
  matchSymptom,
  CONSULT_NOTICE,
  EMERGENCY_NUMBER,
  FORBIDDEN_OUTPUT,
  SYMPTOMS,
} from "@/lib/triage";
import { route, type AssistantActor } from "@/lib/assistant";
import {
  providerConfig,
  redactForProvider,
  validateProviderOutput,
  PROVIDER_FORBIDDEN,
} from "@/lib/assistant-provider";

/**
 * The assistant's safety properties.
 *
 * These tests exist because the failures here are not crashes. A diagnosis or a
 * dose would render perfectly, look helpful, and be the worst thing this codebase
 * could ship. So they are asserted as *properties of the output*, not as samples
 * of prose that could drift.
 */

const customer: AssistantActor = {
  userId: 0,
  role: "customer",
  pharmacyId: null,
  name: "Test Customer",
};

beforeEach(async () => {
  await resetDemo();
});
afterAll(async () => {
  await resetDemo();
});

describe("emergency screening", () => {
  it("fires on breathing difficulty", () => {
    expect(screenForEmergency("I cannot breathe properly").triggered).toBe(true);
  });

  it("fires on stroke signs", () => {
    for (const phrase of [
      "my face is drooping",
      "sudden weakness on one side",
      "slurred speech started",
      "loss of vision",
    ]) {
      expect(screenForEmergency(phrase).triggered).toBe(true);
    }
  });

  it("fires on severe chest pain", () => {
    expect(screenForEmergency("I have severe chest pain").triggered).toBe(true);
  });

  it("fires on unconsciousness", () => {
    expect(screenForEmergency("my father is unconscious").triggered).toBe(true);
  });

  it("fires on a rash that does not fade", () => {
    expect(screenForEmergency("there is a rash that does not fade when pressed").triggered).toBe(true);
  });

  it("fires on self-harm", () => {
    expect(screenForEmergency("I want to kill myself").triggered).toBe(true);
  });

  it("is not a negative keyword match", () => {
    // The critical property. A person in trouble does not describe themselves
    // using the phrases we happened to write, and a screen that concluded safety
    // from their silence would be worse than no screen at all.
    expect(screenForEmergency("I feel very unwell").triggered).toBe(false);
    expect(screenForEmergency("something is wrong and I am scared").triggered).toBe(false);
  });

  it("catches an emergency even when it is buried in a long message", () => {
    const r = screenForEmergency(
      "so I woke up this morning and my knee was stiff and then later in the afternoon I could not breathe properly at all"
    );
    expect(r.triggered).toBe(true);
  });

  it("runs before any clarifying question", () => {
    const result = triage(["I cannot breathe", ""]);
    expect(result.responseType).toBe("emergency");
    // No question asked: someone in difficulty must not be made to answer four
    // follow-ups first.
    expect(result.nextQuestion).toBeNull();
  });

  it("names 112", () => {
    const result = triage(["severe chest pain"]);
    expect(result.emergencyContact).toBe(EMERGENCY_NUMBER);
    expect(result.message).toContain("112");
  });

  it("escalates on a red-flag answer, not only on the opening message", () => {
    // The danger is answering the first question and then going quiet.
    const result = triage(["I have a headache", "no", "yes, the worst headache of my life"]);
    expect(result.responseType).toBe("emergency");
  });
});

describe("the health boundary", () => {
  it("never states a diagnosis", () => {
    const transcripts = [
      ["I have a fever"],
      ["I have a fever", "two days", "101", "adult", "no"],
      ["what do I have?", "I have chest congestion"],
      ["my child has a rash"],
      ["I am dizzy and it will not stop"],
    ];
    for (const t of transcripts) {
      const claim = findUnhedgedClaim(triage(t).message);
      // Hedge-aware on purpose: "this is not a diagnosis of what you have" is the
      // opposite of a diagnosis, and a rule that fired on it would have stopped
      // catching anything at all.
      expect(claim).toBeNull();
    }
  });

  it("never gives a dose or a duration of treatment", () => {
    for (const t of [["I have a fever"], ["I have a cough", "three days", "no", "no", "no", "adult"]]) {
      const message = triage(t).message;
      expect(message).not.toMatch(/\d+\s*(mg|ml|mcg)\b/i);
      expect(message).not.toMatch(/take \d+/i);
      // A duration of *taking* something, not a duration the person already has a
      // symptom for — "three days of cough" is answering our own question back.
      expect(message).not.toMatch(/take .{0,30}?for \d+ days/i);
    }
  });

  it("never tells anyone to stop a treatment", () => {
    for (const s of SYMPTOMS) {
      for (const line of [...s.selfCare, ...s.possibleCauses, ...s.watchFor]) {
        expect(line.toLowerCase()).not.toContain("stop taking");
      }
    }
  });

  it("never names a medicine or a product", () => {
    // A category is fine — "look for oral rehydration sachets" is general and a
    // pharmacist confirms it. A product recommendation is not, because this
    // module has no business making one.
    const products = ["dolo", "crocin", "brufen", "paracetamol 500", "augmentin", "azithral"];
    for (const t of [["I have loose motions", "two days", "no", "thirsty", "no", "adult"]]) {
      const message = triage(t).message.toLowerCase();
      for (const p of products) expect(message).not.toContain(p);
    }
  });

  it("never promises a symptom is harmless", () => {
    for (const t of [["I have a cough", "two days", "no", "no", "no", "adult"]]) {
      const message = triage(t).message;
      expect(message.toLowerCase()).not.toMatch(/harmless|not serious|no need to (see|consult)/i);
      // And it says what it could not rule out.
      expect(message).toMatch(/cannot rule (one in or out|it in or out)/i);
    }
  });

  it("ends every health answer with a referral", () => {
    const transcripts = [
      ["I have a fever"],
      ["I have a fever", "two days", "101", "adult", "no"],
      ["what is this pain in my stomach"],
      ["zzzz qqqq"],
    ];
    for (const t of transcripts) {
      const result = triage(t);
      expect(result.consultADoctor).toBe(true);
      expect(result.message.toLowerCase()).toMatch(/consult|emergency|professional/);
    }
  });

  it("carries the consultation notice in the full answer", () => {
    const r = triage(["I have a cough", "two days", "no", "no", "no", "adult"]);
    expect(r.message).toContain("general health information");
    expect(r.message).toContain(CONSULT_NOTICE.slice(0, 30));
  });

  it("gives educational information without claiming certainty", () => {
    const r = triage(["I have a cough", "two days", "no", "no", "no", "adult"]);
    expect(r.possibleCauses?.length).toBeGreaterThan(0);
    // No probabilities. A percentage would imply a measurement that was never made.
    expect(r.message).not.toMatch(/\d{1,3}\s*%/);
  });

  it("says when the information is not enough", () => {
    const r = triage(["something feels strange"]);
    expect(r.responseType).toBe("insufficient-information");
    expect(r.message).toMatch(/not going to guess|could not identify/i);
  });

  it("asks about age where it changes the answer, and nothing more", () => {
    // Walk the conversation until the age question is reached, so this test does
    // not depend on the order the questions happen to be declared in.
    let transcript = ["I have a fever"];
    let r = triage(transcript);
    let guard = 0;
    while (r.nextQuestion && !/old/i.test(r.nextQuestion) && guard++ < 8) {
      transcript = [...transcript, "no"];
      r = triage(transcript);
    }
    expect(r.nextQuestion).toMatch(/old/i);
    // It never asks for identifying details.
    const asked = triage(["I have a fever", "two days", "101", "adult", "no"]).asked.join(" ").toLowerCase();
    for (const forbidden of ["name", "address", "id number", "aadhaar", "phone", "age and date"]) {
      expect(asked).not.toContain(forbidden);
    }
  });
});

describe("symptom matching", () => {
  it("understands plain English and transliterated Hindi", () => {
    expect(matchSymptom("I have bukhar")?.key).toBe("fever");
    expect(matchSymptom("bahut sardi ho rahi hai")?.key).toBe("cough");
    expect(matchSymptom("sir dard ho raha hai")?.key).toBe("headache");
    expect(matchSymptom("pet mein dard")?.key).toBe("stomach_pain");
  });

  it("returns nothing for an unrelated question", () => {
    expect(matchSymptom("where is my order")).toBeNull();
  });
});

// ------------------------------------------------------------------ assistant

describe("the assistant router", () => {
  it("greets", async () => {
    const r = await route("hello", customer);
    expect(r.intent).toBe("greeting");
    expect(r.answeredBy).toBe("local");
  });

  it("falls back honestly on something it does not understand", async () => {
    const r = await route("asdkjhaskdjh", customer);
    expect(r.intent).toBe("unknown");
    expect(r.unsure).toBe(true);
    // Even the fallback must not invite the user to take medical advice from it.
    expect(r.message).toMatch(/cannot diagnose or prescribe/i);
  });

  it("answers with the caller's own orders and nobody else's", async () => {
    const me = (
      await queryOne<{ id: number }>("SELECT id FROM users WHERE role='customer' ORDER BY id LIMIT 1")
    )!;
    const someoneElse = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role='customer' AND id <> $1 ORDER BY id LIMIT 1",
        [me.id]
      )
    )!;
    await queryRunSafe(
      `INSERT INTO requests (customer_name, medicine_id, qty, fulfilment_type, status, created_at)
       SELECT 'Someone Else', id, 1, 'pickup', 'Requested', now() FROM medicines LIMIT 1`
    );

    const r = await route("what is the status of my order", {
      ...customer,
      userId: someoneElse.id,
    });
    expect(r.intent).toBe("order_status");
    expect(r.message).not.toContain("Someone Else");
  });

  it("answers a medicine availability question from the real catalogue", async () => {
    const r = await route("is there Dolo 650 in stock nearby?", customer);
    expect(r.intent).toBe("medicine_availability");
    expect(r.responseType).toBe("pharmacy-search");
    // Every product and quantity came from a row that exists.
    for (const item of r.catalogue ?? []) {
      expect(item.display_name.length).toBeGreaterThan(0);
      for (const p of item.pharmacies) {
        const row = await queryOne<{ free: number }>(
          "SELECT (qty_total - qty_locked)::int AS free FROM inventory WHERE pharmacy_id = $1 AND medicine_id = $2",
          [p.id, item.id]
        );
        expect(row!.free).toBe(p.free);
      }
    }
  });

  it("says so when a medicine is not in the catalogue, rather than inventing one", async () => {
    const r = await route("where can I buy Zorblax 900mg", customer);
    expect(r.intent).toBe("medicine_availability");
    expect(r.catalogue ?? []).toHaveLength(0);
    expect(r.message).toMatch(/rather .* than invent/i);
  });

  it("never turns a symptom into a medicine recommendation", async () => {
    const r = await route("I have a fever, what medicine should I take?", customer);
    expect(r.responseType).not.toBe("pharmacy-search");
    expect(r.catalogue ?? []).toHaveLength(0);
    expect(findUnhedgedClaim(r.message)).toBeNull();
  });

  it("routes a health question to health, not to app navigation", async () => {
    const r = await route("I have a bad cough and fever", customer);
    expect(["health-information", "clarifying-question"]).toContain(r.responseType);
  });

  it("reports where the answer came from", async () => {
    const r = await route("what should I know about fever?", customer);
    expect(r.answeredBy).toBe("local");
  });
});

// ------------------------------------------------------------------ provider

describe("the optional provider", () => {
  it("is off unless configured", () => {
    delete process.env.MM_ASSISTANT_PROVIDER_URL;
    delete process.env.MM_ASSISTANT_PROVIDER_KEY;
    expect(providerConfig()).toBeNull();
  });

  it("works with no provider at all", async () => {
    delete process.env.MM_ASSISTANT_PROVIDER_URL;
    delete process.env.MM_ASSISTANT_PROVIDER_KEY;
    const r = await route("what should I know about fever?", customer);
    expect(r.answeredBy).toBe("local");
    expect(r.message.length).toBeGreaterThan(0);
  });

  it("redacts identifying details before anything would leave the server", () => {
    const out = redactForProvider(
      "My name is Rahul, call me on 9876543210, I live at 42 MG Road, email rahul@example.com"
    );
    expect(out).not.toContain("9876543210");
    expect(out).not.toContain("rahul@example.com");
    expect(out).not.toContain("Rahul");
  });

  it("rejects model output that diagnoses, doses or drops the referral", () => {
    for (const bad of [
      "You have dengue fever.",
      "Take 500 mg paracetamol every 6 hours. Consult a doctor if it persists.",
      "This is nothing to worry about, consult a doctor anyway.",
      "Stop taking your tablets. Consult me.",
      "I guarantee you will be fine. Consult a doctor.",
    ]) {
      expect(validateProviderOutput(bad).ok).toBe(false);
    }
  });

  it("rejects model output that invents an emergency number", () => {
    const out = validateProviderOutput("Call 999 now. Please consult a doctor.", "112");
    expect(out.ok).toBe(false);
  });

  it("accepts safe rewording that keeps the referral", () => {
    const out = validateProviderOutput(
      "That sounds uncomfortable. Rest and drink fluids. Please consult a doctor if it continues.",
      "112"
    );
    expect(out.ok).toBe(true);
  });

  it("lists every forbidden pattern it checks", () => {
    expect(PROVIDER_FORBIDDEN.length).toBeGreaterThan(5);
  });
});

async function queryRunSafe(sql: string) {
  const { queryRun } = await import("@/lib/db");
  await queryRun(sql);
}