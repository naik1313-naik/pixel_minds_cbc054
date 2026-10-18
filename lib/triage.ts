/**
 * The symptom helper.
 *
 * ## What this is
 *
 * A triage and information aid. Given what a person describes it:
 *
 *  1. screens for **emergency warning signs first**, before anything else;
 *  2. asks a short set of follow-up questions;
 *  3. gives **general educational information** — possible causes, general
 *     comfort measures, and what to watch for;
 *  4. says plainly when the information available is not enough.
 *
 * ## What it is not
 *
 * It does not diagnose, prescribe, dose, or tell anyone to change or stop a
 * treatment. It does not name which condition a person has; it names what a
 * symptom is *commonly associated with* at a general, educational level, and
 * says explicitly that only a clinician can narrow that down for one person.
 *
 * Every medical answer ends with a referral. That is a property of this module,
 * not a footer that could be dropped.
 *
 * ## Two design decisions worth stating
 *
 * **Emergencies are matched by presence, never ruled out by absence.** The
 * screen looks for warning signs in what the person actually said. It never
 * concludes "no emergency" from the absence of a keyword — a person in
 * difficulty does not describe themselves using the list we happened to write.
 *
 * **The emergency screen runs before the questions.** Someone who cannot breathe
 * should not have to answer four follow-ups before being told to get help.
 *
 * ## Why it cannot go further
 *
 * The catalogue behind this is curated, not regulatory: prescription flags carry
 * `rx_basis = 'curated'`, manufacturers and barcodes are unknown, and prices
 * are invented. More fundamentally, no amount of prompting can supply kidney
 * function, allergies, pregnancy, age-adjusted dosing, or a drug interaction
 * history. Those are why a diagnosis is made by a person who can examine you.
 */

/** India's single emergency number. Used whenever urgency is highest. */
export const EMERGENCY_NUMBER = "112";
export const EMERGENCY_NUMBER_LABEL = "112 (national emergency number, India)";

export type Urgency = "emergency" | "see-doctor-soon" | "self-care" | "insufficient-information";
export type ResponseType = "emergency" | "health-information" | "clarifying-question" | "insufficient-information";

/**
 * Emergency indicators, screened before anything else.
 *
 * Each carries what to do. Kept phrase-based and broad on purpose: this is a
 * safety screen, and the failure mode of missing a phrase is much worse than
 * the failure mode of a false alarm, which costs someone an unnecessary trip.
 */
export const EMERGENCY_INDICATORS: { pattern: RegExp; why: string }[] = [
  {
    pattern: /\b(can'?t breathe|cannot breathe|can not breathe|could ?n'?t? ?breathe|could not breathe|struggling to breathe|gasping|choking|choked|blue lips)\b/i,
    why: "Difficulty breathing is an emergency.",
  },
  {
    pattern: /\b(face droop|face is drooping|drooping face|slurred speech|sudden numbness|sudden weakness|one side (?:of the (?:body|face)|is weak)|can'?t lift (?:my|his|her) arm|vision (?:loss|lost)|loss of vision)\b/i,
    why: "These can be signs of a stroke, where every minute matters.",
  },
  {
    pattern: /\b(severe chest pain|crushing chest pain|chest pain that|chest is tight|tightness in (?:my|the) chest)\b/i,
    why: "Severe or crushing chest pain can be a heart attack.",
  },
  {
    pattern: /\b(unconscious|unresponsive|passed out|fainted and|not waking|will not wake|collapsed and)\b/i,
    why: "Someone who is unconscious or not waking needs emergency care now.",
  },
  {
    pattern: /\b(severe bleeding|won'?t stop bleeding|blood everywhere|bleeding heavily|cutting my wrist|overdose|took too many|poison)\b/i,
    why: "Serious bleeding, overdose or poisoning needs emergency care.",
  },
  {
    pattern: /\b(seizure|fitting|convulsion|anaphylaxis|throat closing|swelling of (?:my )?throat)\b/i,
    why: "Seizures, anaphylaxis or a closing throat need emergency care.",
  },
  {
    pattern: /\b(knee high|neck stiff|neck stiffness|non-blanching|does not fade when|skin feels cold and clammy)\b/i,
    why: "A rash that does not fade under pressure, or a stiff neck with fever, can indicate a serious infection.",
  },
  {
    pattern: /\b(want to die|suicidal|kill myself|end my life|harm myself)\b/i,
    why: "If you are thinking about harming yourself, please talk to someone right now and call for help.",
  },
];

/** The referral that closes every medical answer. Never optional. */
export const CONSULT_NOTICE =
  "⚠️ This is general health information, not a diagnosis. Please consult a doctor or pharmacist " +
  "about your own situation — especially if you are pregnant, breastfeeding, have a chronic " +
  "condition, or take other medicines.";

export interface SymptomDefinition {
  key: string;
  /** How a person might describe it, in English or the languages people type here. */
  phrases: string[];
  questions: { id: string; ask: string }[];
  /**
   * Answers that escalate.
   *
   * Checked against every answer given, because a red flag can surface in the
   * answer to a later question rather than the first.
   */
  redFlags: { when: RegExp; why: string }[];
  /**
   * General educational information about what this symptom is commonly
   * associated with. Deliberately not a diagnosis and never probabilities: this
   * is a list of things a clinician would consider, not a conclusion.
   */
  possibleCauses: string[];
  /** General comfort measures. Never a product, a dose or a duration. */
  selfCare: string[];
  /** Worth watching for, and when it changes the picture. */
  watchFor: string[];
  /** Catalogue categories worth browsing. A category, never a product. */
  browseCategories: string[];
}

export const SYMPTOMS: SymptomDefinition[] = [
  {
    key: "fever",
    phrases: ["fever", "bukhar", "temperature", "febrile", "high temp", "gaaram", "feverish"],
    questions: [
      { id: "days", ask: "How many days have you had the fever?" },
      { id: "temp", ask: "Roughly what temperature, if you measured it?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
      { id: "rash", ask: "Is there any rash that does not fade when you press a glass against it?" },
    ],
    redFlags: [
      { when: /\b(3|4|5|6|7|eight|nine|10) (days|day) or more\b|\bmore than\b|\bfor a week\b/i, why: "A fever lasting three days or more should be looked at by a doctor." },
      { when: /\b(10[5-9]|10[34]|102|103|104|105|106|very high|extremely high)\b/i, why: "A very high fever needs medical attention today." },
      { when: /\b(under 3 months?|less than 3 months?|baby|infant)\b/i, why: "A fever in a very young baby needs a doctor immediately." },
    ],
    possibleCauses: [
      "Most fevers are part of the body responding to an infection, and resolve as it does.",
      "Less commonly, prolonged fever can come from inflammatory conditions, or from a reaction to a medicine or vaccine.",
      "Which one it is depends on examination, tests, and history — none of which this can see.",
    ],
    selfCare: [
      "Drink fluids regularly, more often than you feel like you need to.",
      "Rest, and keep the room comfortably cool rather than bundling up.",
      "A cool damp cloth on the forehead helps with comfort.",
    ],
    watchFor: [
      "A rash that does not fade when pressed.",
      "Stiff neck, severe headache, or confusion.",
      "Vomiting, or not able to keep fluids down.",
    ],
    browseCategories: ["Antacids and oral rehydration", "First aid and antiseptics"],
  },
  {
    key: "headache",
    phrases: ["headache", "sir dard", "head pain", "migraine", "sar dard", "head hurts"],
    questions: [
      { id: "onset", ask: "Did it start suddenly, within a second or two?" },
      { id: "worst", ask: "Would you describe it as the worst headache you have ever had?" },
      { id: "neuro", ask: "Any weakness in an arm or leg, trouble speaking, or blurred vision?" },
      { id: "days", ask: "How long have you had it?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\bsudden(ly)?\b|\bwithin a second\b|\bthunderclap\b/i, why: "A sudden, severe headache can be a serious emergency." },
      { when: /\bworst headache\b|\bworst of my life\b/i, why: "The worst headache of your life needs emergency assessment." },
      { when: /\b(yes|weakness|numbness|trouble speaking|blurred|confusion|seizure)\b/i, why: "Headache with weakness, speech or vision changes is an emergency." },
      { when: /\b(yes|older than 50|over 50)\b/i, why: "A new headache after the age of 50 should be examined." },
    ],
    possibleCauses: [
      "Tension-type headaches are common and are usually mild to moderate, without other symptoms.",
      "Migraine typically brings a throbbing quality, sometimes nausea and sensitivity to light or sound, and often a family pattern.",
      "Cluster headaches are rarer, come in repeated attacks around one eye, and are very severe.",
      "A new pattern of headache can also come from blood pressure, sleep, vision or posture problems.",
    ],
    selfCare: [
      "Rest in a quiet, dimly lit room.",
      "Drink water — dehydration commonly makes headaches worse.",
      "A cool pack on the forehead or neck can help.",
      "Note what you were doing when it started; that is useful for a doctor.",
    ],
    watchFor: ["Headaches that wake you from sleep or get steadily worse.", "Headaches with fever or a stiff neck.", "Any headache after a head injury."],
    browseCategories: ["Pain relief and fever"],
  },
  {
    key: "loose_motions",
    phrases: ["loose motion", "loose motions", "diarrhoea", "diarrhea", "dast", "loose stomach"],
    questions: [
      { id: "days", ask: "How many days have you had loose motions?" },
      { id: "blood", ask: "Is there any blood, or black colouring?" },
      { id: "thirst", ask: "Are you unusually thirsty, or urinating less than usual?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
      { id: "travel", ask: "Any recent travel or food from a place you are not sure about?" },
    ],
    redFlags: [
      { when: /\b(blood|black|tarry)\b/i, why: "Blood or black stool needs a doctor today." },
      { when: /\b(3|4|5|6|7|eight|nine) (days|day) or more\b|\bmore than\b|\bfor a week\b/i, why: "Loose motions lasting three days or more should be checked." },
      { when: /\b(thirsty|less urine|urinating less|dehydrat)\b/i, why: "Signs of dehydration need attention today." },
      { when: /\b(yes|travel|travelling|unhygienic|street food)\b/i, why: "Recent travel or questionable food makes this worth a doctor's look." },
      { when: /\b(under 6 months?|infant|baby)\b/i, why: "Diarrhoea in a young baby needs a doctor quickly." },
    ],
    possibleCauses: [
      "Viral infection is the most common cause, usually lasting a few days and passing on its own.",
      "Bacterial infection is less common and can be more severe, and sometimes needs assessment.",
      "Food intolerance or a reaction to a medicine can also cause it.",
      "Irritable bowel patterns and, in some people, longer-term conditions look different and need investigation.",
    ],
    selfCare: [
      "Keep drinking fluids continuously — this matters more than anything else here.",
      "Oral rehydration sachets are the right thing to look for; a pharmacist can advise on the packet.",
      "Eat simple food as appetite returns; avoid very fatty or spicy food for now.",
      "Wash hands carefully after every visit to the toilet, and keep ill people away from food preparation.",
    ],
    watchFor: ["Blood in the stool.", "Signs of dehydration: very little urine, dry mouth, dizziness on standing.", "Fever, or severe abdominal pain."],
    browseCategories: ["Antacids and oral rehydration", "First aid and antiseptics"],
  },
  {
    key: "cough",
    phrases: ["cough", "khansi", "khaansi", "cold", "sardi", "sore throat", "throat pain", "congestion"],
    questions: [
      { id: "days", ask: "How long has the cough been going on?" },
      { id: "breath", ask: "Are you short of breath, or unable to speak a full sentence?" },
      { id: "wheeze", ask: "Is there any wheezing when you breathe?" },
      { id: "fever", ask: "Do you have a fever with it?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\b(short of breath|breathless|can'?t breathe|cannot breathe|unable to speak)\b/i, why: "Breathlessness needs urgent medical attention." },
      { when: /\b(wheeze|wheezing|noisy breathing)\b/i, why: "Wheezing needs to be seen by a doctor, ideally today." },
      { when: /\b(coughing up blood|blood in sputum|haemoptysis)\b/i, why: "Coughing up blood needs urgent medical attention." },
      { when: /\b(yes|fever)\b/i, why: "A cough with fever should be checked by a doctor." },
      { when: /\b(3|4|5|6|7|eight|nine) (weeks|week)\b|\bmore than\b/i, why: "A cough lasting three weeks or more should be examined." },
      { when: /\b(under 2 months?|infant|baby|elderly)\b/i, why: "A cough in a very young baby or an elderly person needs a doctor." },
    ],
    possibleCauses: [
      "Most coughs come with a viral infection of the upper airway, and settle within one to three weeks.",
      "Post-nasal drip and irritation are common causes of a cough that lingers after the infection has gone.",
      "Asthma, allergy and acid reflux are common causes of a longer-lasting dry cough.",
      "A cough that lasts more than three weeks, or comes with weight loss or fever, needs to be examined.",
    ],
    selfCare: [
      "Warm fluids and, for anyone over one year old, honey soothe an irritated throat.",
      "Steam from hot water loosens congestion; take care not to burn yourself.",
      "Sleep propped up on an extra pillow if lying flat makes it worse.",
      "Keep air around you free of smoke and dust.",
    ],
    watchFor: ["Breathlessness, or an inability to speak in full sentences.", "Coughing up blood.", "A cough lasting more than three weeks, or with fever or weight loss."],
    browseCategories: ["Cold, cough and respiratory", "Oral liquids and syrups"],
  },
  {
    key: "stomach_pain",
    phrases: ["stomach", "pet dard", "abdomen", "belly", "tummy", "abdominal", "stomach ache", "pet dard"],
    questions: [
      { id: "where", ask: "Where is the pain — upper, lower, or around the navel?" },
      { id: "severity", ask: "On a scale of 1 to 10, how bad is it right now?" },
      { id: "vomit", ask: "Have you been vomiting?" },
      { id: "blood", ask: "Any blood in the vomit or stool?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\b(9|10|ten|nine|very bad|severe|excruciating|worst)\b/i, why: "Severe abdominal pain needs emergency assessment." },
      { when: /\b(blood|vomiting blood|black stool|tarry)\b/i, why: "Blood in vomit or black stool is an emergency." },
      { when: /\b(lower right|right lower|one side|localis)\w*/i, why: "Pain localised to one side, especially the lower right, needs examination today." },
      { when: /\b(pregnant|pregnancy)\b/i, why: "Abdominal pain in pregnancy needs a doctor, urgently." },
    ],
    possibleCauses: [
      "Indigestion, gastritis and acid reflux are common causes of upper abdominal discomfort.",
      "Food intolerance and infection commonly cause pain with vomiting or diarrhoea.",
      "Constipation, period-related pain and urinary infections can also present as abdominal pain.",
      "Some conditions present as pain elsewhere but refer pain to the abdomen, which is exactly why examination matters.",
    ],
    selfCare: [
      "Sip fluids rather than taking large drinks at once.",
      "Rest, and keep food simple until you know what settles.",
      "Note exactly where the pain is and when it comes and goes — that map genuinely helps a doctor.",
    ],
    watchFor: ["Pain that keeps moving or getting worse.", "Fever with abdominal pain.", "Any blood in vomit or stool.", "Pain during pregnancy."],
    browseCategories: ["Antacids and oral rehydration", "Gastrointestinal and acidity"],
  },
  {
    key: "urination",
    phrases: ["urine", "urinating", "peshab", "burning urine", "uti", "burning while", "pain while urinating"],
    questions: [
      { id: "burning", ask: "Is there a burning or stinging feeling when you pass urine?" },
      { id: "fever", ask: "Do you have a fever or back pain?" },
      { id: "blood", ask: "Any blood in the urine?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\b(fever|back pain|flank)\b/i, why: "Fever or back pain with urinary symptoms can mean a kidney infection, which needs a doctor today." },
      { when: /\b(pregnant|pregnancy)\b/i, why: "Urinary symptoms in pregnancy need a doctor's advice." },
    ],
    possibleCauses: [
      "Urinary tract infections are a common cause of burning and of needing to pass urine more often.",
      "Dehydration, and irritation from soaps or detergents, can cause similar discomfort.",
      "Kidney stones typically cause pain in the back or side, sometimes with blood in the urine.",
    ],
    selfCare: ["Drink plenty of water through the day.", "Go when you need to rather than holding it.", "Avoid fragranced products around the area."],
    watchFor: ["Fever or back pain.", "Blood in the urine.", "Pain that moves to the lower right of the abdomen."],
    browseCategories: ["Kidney and urinary health"],
  },
  {
    key: "rash",
    phrases: ["rash", "itch", "itches", "itching", "skin problem", "skin rash", "hives"],
    questions: [
      { id: "spread", ask: "Is it spreading, or staying in one area?" },
      { id: "face", ask: "Is it on your face, or around your mouth and eyes?" },
      { id: "breath", ask: "Any difficulty breathing or swelling of the lips?" },
      { id: "new", ask: "Have you started anything new — a medicine, a food, a product — in the last few weeks?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\b(difficulty breathing|trouble breathing|swelling of (?:the )?lips|face is swelling|throat)\b/i, why: "Breathing difficulty or swelling of the lips or face is an emergency." },
      { when: /\b(does not fade|non-blanching|not fading)\b/i, why: "A rash that does not fade under pressure can mean a serious infection." },
      { when: /\b(yes|face|mouth|eyes|around the eyes)\b/i, why: "A rash on the face, mouth or around the eyes needs a doctor today." },
    ],
    possibleCauses: [
      "Contact reactions to soaps, detergents, metals or plants are very common and settle when the trigger is removed.",
      "Allergic reactions, including hives, often come and go over hours.",
      "Irritant and inflammatory skin conditions have their own patterns that a doctor examines rather than guesses.",
      "Some infections produce a rash, and a medicine reaction can look similar.",
    ],
    selfCare: [
      "Stop using anything new you started recently — that is often the trigger.",
      "Cool compresses and loose cotton clothing reduce irritation.",
      "Do not scratch; keep nails short.",
      "Take a photo of the rash each day; changes are useful for a doctor.",
    ],
    watchFor: ["Breathing difficulty or swelling of the lips.", "A rash that does not fade under pressure.", "Fever with a rash.", "The rash spreading quickly."],
    browseCategories: ["Dermatology and skin care", "Topical creams and ointments"],
  },
  {
    key: "dizziness",
    phrases: ["dizzy", "dizziness", "chakkar", "giddiness", "faint", "blackout", "light headed"],
    questions: [
      { id: "fainted", ask: "Have you actually fainted, or lost consciousness at any point?" },
      { id: "chest", ask: "Any chest pain or palpitations alongside it?" },
      { id: "falling", ask: "Have you fallen or injured yourself?" },
      { id: "meds", ask: "Do you take any medicines for blood pressure or diabetes?" },
      { id: "age", ask: "Roughly how old is the person this is about?" },
    ],
    redFlags: [
      { when: /\b(fainted|passed out|lost consciousness|blackout)\b/i, why: "Fainting needs medical assessment." },
      { when: /\b(chest pain|palpitation|heart racing)\b/i, why: "Dizziness with chest pain or palpitations is urgent." },
      { when: /\b(fallen|fall|injury|hit my head)\b/i, why: "A fall, especially with a head injury, needs to be looked at today." },
      { when: /\b(slurred|face droop|one side)\b/i, why: "Weakness or drooping on one side is a stroke warning sign." },
    ],
    possibleCauses: [
      "A drop in blood pressure on standing is a common cause and is often made worse by dehydration.",
      "Skipping meals, dehydration, heat and poor sleep are frequent everyday triggers.",
      "Inner-ear problems and some medicines can also cause light-headedness.",
      "A general practitioner checks heart rhythm and blood pressure for a reason: it separates the common causes from the ones that matter.",
    ],
    selfCare: [
      "Stand up slowly, and sit down if you feel light-headed.",
      "Keep hydrated and eat regularly; skipping meals is a common trigger.",
      "Do not drive or work at height while this is happening.",
    ],
    watchFor: ["Fainting, chest pain, or palpitations.", "Weakness or numbness on one side.", "Any fall that involved a head injury."],
    browseCategories: ["Vitamins and minerals"],
  },
];

// ---------------------------------------------------------------- matching

const SYNONYMS: Record<string, string> = {
  bukhar: "fever",
  sardi: "cough",
  khansi: "cough",
  khaansi: "cough",
  "sir dard": "headache",
  "sar dard": "headache",
  dast: "loose_motions",
  diarrhoea: "loose_motions",
  diarrhea: "loose_motions",
  "stomach ache": "stomach_pain",
  tummy: "stomach_pain",
  pet: "stomach_pain",
  abdomen: "stomach_pain",
  seena: "stomach_pain",
  peshab: "urination",
  chakkar: "dizziness",
  itch: "rash",
};

const STOP = /[^\p{L}\s]/gu;

/** Finds the symptom someone is describing, if we know it. */
export function matchSymptom(input: string): SymptomDefinition | null {
  const text = ` ${input.toLowerCase().replace(STOP, " ").replace(/\s+/g, " ").trim()} `;
  for (const [from, to] of Object.entries(SYNONYMS)) {
    if (text.includes(` ${from} `)) {
      const hit = SYMPTOMS.find((s) => s.key === to);
      if (hit) return hit;
    }
  }
  for (const s of SYMPTOMS) {
    if (s.phrases.some((p) => text.includes(` ${p} `))) return s;
  }
  return null;
}

/**
 * Emergency screen. Runs on presence of a warning sign.
 *
 * Never concludes safety from absence: if nothing here matches, that is not
 * evidence that nothing is wrong. It is only evidence that this screen did not
 * recognise it.
 */
export function screenForEmergency(text: string): { triggered: boolean; why?: string } {
  for (const indicator of EMERGENCY_INDICATORS) {
    if (indicator.pattern.test(text)) return { triggered: true, why: indicator.why };
  }
  return { triggered: false };
}

// ---------------------------------------------------------------- conversation

export interface TriageResult {
  responseType: ResponseType;
  symptom: string;
  urgency: Urgency;
  asked: string[];
  nextQuestion: string | null;
  redFlagsCleared: boolean;
  redFlagsFound: string[];
  possibleCauses?: string[];
  selfCare?: string[];
  watchFor?: string[];
  browseCategories: string[];
  /** Always true for a medical answer. A property, not a footer. */
  consultADoctor: true;
  emergencyContact?: string;
  message: string;
}

function emergencyMessage(why: string, extra = ""): string {
  return (
    `${why}\n\n` +
    (extra ? `${extra}\n\n` : "") +
    `Call ${EMERGENCY_NUMBER_LABEL} now, or get to the nearest emergency department. Do not wait ` +
    `for this to settle, and do not drive yourself if you feel unsafe doing so.\n\n` +
    `⚠️ Consult a doctor — this needs urgent professional care.`
  );
}

/**
 * Runs the conversation.
 *
 * Pure and total: the same transcript always produces the same answer and it
 * never throws, so no caller can end up without the referral or the emergency
 * check having run.
 */
export function triage(transcript: string[]): TriageResult {
  const said = transcript.join(" ");
  const last = transcript[transcript.length - 1] ?? "";

  // 1. Emergency screen, before anything else and before any question.
  const emergency = screenForEmergency(said);
  if (emergency.triggered) {
    return {
      responseType: "emergency",
      symptom: "emergency",
      urgency: "emergency",
      asked: [],
      nextQuestion: null,
      redFlagsCleared: false,
      redFlagsFound: [emergency.why ?? "Emergency warning sign detected."],
      browseCategories: [],
      consultADoctor: true,
      emergencyContact: EMERGENCY_NUMBER,
      message: emergencyMessage(emergency.why ?? "What you describe needs emergency care."),
    };
  }

  // 2. Find the symptom across the whole conversation, not just the last turn.
  const symptom = transcript.map((t) => matchSymptom(t)).find(Boolean) ?? null;

  if (!symptom) {
    return {
      responseType: "insufficient-information",
      symptom: "unknown",
      urgency: "insufficient-information",
      asked: [],
      nextQuestion: null,
      redFlagsCleared: false,
      redFlagsFound: [],
      browseCategories: [],
      consultADoctor: true,
      message:
        "I could not identify which problem you are describing, and I am not going to guess — a wrong guess " +
        "here is worse than none.\n\n" +
        "To describe it, tell me the main thing that is bothering you and roughly how long it has been going on. " +
        "You do not need to give me your name, address or any documents.\n\n" +
        CONSULT_NOTICE,
    };
  }

  // 3. Split the transcript: everything up to and including the first mention is
  //    context, everything after it is answers to our questions.
  const firstMention = transcript.findIndex((t) => matchSymptom(t) !== null);
  const answers = transcript.slice(firstMention + 1);
  const asked = symptom.questions.slice(0, answers.length).map((q) => q.ask);
  const answerText = answers.join(" | ");

  const flags = symptom.redFlags.filter((f) => f.when.test(answerText));
  if (flags.length > 0) {
    return {
      responseType: "emergency",
      symptom: symptom.key,
      urgency: "emergency",
      asked,
      nextQuestion: null,
      redFlagsCleared: true,
      redFlagsFound: flags.map((f) => f.why),
      browseCategories: [],
      consultADoctor: true,
      emergencyContact: EMERGENCY_NUMBER,
      message: emergencyMessage(flags[0].why),
    };
  }

  // 4. Still gathering answers: ask one more, reveal nothing.
  const next = symptom.questions[answers.length]?.ask ?? null;
  if (next) {
    return {
      responseType: "clarifying-question",
      symptom: symptom.key,
      urgency: "self-care",
      asked,
      nextQuestion: next,
      redFlagsCleared: false,
      redFlagsFound: [],
      browseCategories: [],
      consultADoctor: true,
      message:
        `${next}\n\n` +
        `I am asking because the answer changes what I can safely tell you. I cannot diagnose anything, and ` +
        `whatever we get to, please consult a doctor or pharmacist for your own situation.`,
    };
  }

  // 5. Enough answered, nothing alarming: general information, clearly bounded.
  const answered = transcript.length - firstMention - 1;
  const anyYes = /\b(yes|yeah|yep|haan|ha|haa)\b/i.test(answerText);

  return {
    responseType: "health-information",
    symptom: symptom.key,
    // "No red flag found" is not "harmless", and is never reported as one.
    urgency: anyYes ? "see-doctor-soon" : "self-care",
    asked,
    nextQuestion: null,
    redFlagsCleared: true,
    redFlagsFound: [],
    possibleCauses: symptom.possibleCauses,
    selfCare: symptom.selfCare,
    watchFor: symptom.watchFor,
    browseCategories: symptom.browseCategories,
    consultADoctor: true,
    message:
      "Nothing you described sounds like an emergency to me — but I cannot rule one in or out from a chat, " +
      "and only an examination can.\n\n" +
      "**Commonly associated with** (this is general information, not a diagnosis of what you have):\n" +
      symptom.possibleCauses.map((c) => `• ${c}`).join("\n") +
      "\n\n**General comfort measures**:\n" +
      symptom.selfCare.map((s) => `• ${s}`).join("\n") +
      "\n\n**Get to a doctor sooner if you notice**:\n" +
      symptom.watchFor.map((s) => `• ${s}`).join("\n") +
      `\n\n${CONSULT_NOTICE}`,
  };
}

/**
 * Words that mark a sentence as a *denial* rather than a claim.
 *
 * Without this, a naive rule trips on the module's own safety copy: "this is not
 * a diagnosis of what you have" contains "you have", and a safety check that
 * fires on its own disclaimer has quietly stopped checking anything.
 */
const HEDGE = /\b(?:not|never|no|nothing|cannot|can't|won't|whether|instead|rather than|nothing to|isn't|aren't)\b/i;

/**
 * Reports the first sentence that makes a claim, ignoring sentences that deny
 * one.
 *
 * Sentence-level rather than whole-text, because that is the unit in which a
 * human reads "you have X" as a statement about themselves rather than as part
 * of "I cannot tell you that you have X".
 */
export function findUnhedgedClaim(text: string): string | null {
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    if (HEDGE.test(sentence)) continue;
    for (const pattern of FORBIDDEN_OUTPUT) {
      const hit = sentence.match(new RegExp(pattern.source, "i"));
      if (hit) return `${hit[0]} — in: "${sentence.trim().slice(0, 120)}"`;
    }
  }
  return null;
}

/**
 * Words this module must never produce.
 *
 * Exported so the tests can assert against the patterns directly rather than
 * against a hand-written sample of prose that could drift.
 */
export const FORBIDDEN_OUTPUT = [
  // Claiming, never disclaiming. A bare /diagnos(is|ed)/ matched this module's own
  // "this is not a diagnosis" line, which is how a safety rule quietly stops
  // catching anything.
  /\byou (?:have|are suffering from|are showing)\b/i,
  /\b(?:your|the) diagnosis (?:is|was)\b/i,
  /\bdiagnosed (?:with|as)\b/i,
  /\b(?:this|it|that) is (?:definitely|clearly|certainly) \b/i,
  /\byou (?:probably|most likely) have\b/i,
  /\bI (?:can|will) prescribe\b/i,
  /\btake \d+(?:\.\d+)?\s*(?:mg|ml|mcg|g)\b/i,
  /\b\d+\s*(?:mg|ml)\b/i,
  /\bstop taking\b/i,
  /\b(?:you (?:do not|don't) need|there's? no need) to (?:see|consult)\b/i,
  /\bno need to (?:see|consult|worried)\b/i,
  /\b(?:it's|it is) (?:harmless|nothing to worry about|not serious)\b/i,
  /\bguarantee\b/i,
  /\bcure[sd]?\b/i,
] as const;