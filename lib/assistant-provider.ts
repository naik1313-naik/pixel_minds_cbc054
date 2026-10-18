/**
 * Optional language-model adapter.
 *
 * The assistant is fully functional with this switched off, which is the
 * default. When it is switched on, the model is allowed to do exactly one
 * thing: rewrite the answer produced by `lib/triage.ts` into clearer prose.
 *
 * ## What the model is never allowed to do
 *
 * - decide whether this is an emergency — that screen is deterministic and runs
 *   first, and a model cannot override it;
 * - name a medicine, a dose or a duration;
 * - introduce anything not already present in the local answer;
 * - be reached at all when the question is about an emergency.
 *
 * ## Why the default is off
 *
 * A model behind a chat bubble in a medicine app gets asked for medical advice.
 * Every extra place that can produce a sentence is another place a wrong
 * sentence can come from, and this demo has to work with no key, no network and
 * no account. So the local path is the product, and this is a formatting
 * convenience with guardrails around it.
 *
 * ## Privacy
 *
 * Nothing identifying is sent. The request body contains the redacted question
 * text only, and `redactForProvider` strips anything that looks like a name, a
 * phone number, an identifier or an address before it leaves the server.
 */

export interface ProviderConfig {
  url: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputChars: number;
}

/** Reads provider settings from the environment. Returns null when unconfigured. */
export function providerConfig(): ProviderConfig | null {
  const url = process.env.MM_ASSISTANT_PROVIDER_URL?.trim();
  const apiKey = process.env.MM_ASSISTANT_PROVIDER_KEY?.trim();
  if (!url || !apiKey) return null;
  const timeout = Number(process.env.MM_ASSISTANT_PROVIDER_TIMEOUT_MS ?? 8000);
  return {
    url,
    apiKey,
    model: process.env.MM_ASSISTANT_PROVIDER_MODEL?.trim() ?? "local-adapter",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 8000,
    maxOutputChars: 2000,
  };
}

export function providerName(): string | null {
  return providerConfig()?.model ?? null;
}

/**
 * Strips identifying details before anything leaves the machine.
 *
 * Deliberately aggressive: over-redacting a word loses a little meaning, while
 * under-redacting sends a patient's details to a third party. When in doubt,
 * redact.
 */
export function redactForProvider(text: string): string {
  return (
    text
      // Email
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[contact removed]")
      // Phone numbers, including Indian 10-digit forms
      .replace(/\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, "[number removed]")
      .replace(/\b\d{3,5}\s?\d{5,8}\b/g, "[number removed]")
      // Aadhaar-like 12 digit blocks
      .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[identifier removed]")
      // Postal codes and door numbers
      .replace(/\b\d{6}\b/g, "[code removed]")
      // Capitalised name-like pairs, which is crude but catches "for Rahul"
      .replace(/\b(?:for|my|his|her)\s+[A-Z][a-z]{2,}\b/g, (m) => m.replace(/[A-Z][a-z]{2,}$/, "[name removed]"))
      // "my name is Rahul", "I am Rahul"
      .replace(/\b(?:name is|i am|i'm|this is)\s+[A-Z][a-z]{2,}\b/gi, (m) => m.replace(/[A-Z][a-z]{2,}$/, "[name removed]"))
      // Addresses
      .replace(/\b\d+\s+[A-Z][a-z]+\s+(?:Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Nagar|Colony)\b/gi, "[address removed]")
  ).slice(0, 1200);
}

/** Anything the model returns that must never reach a user. */
export const PROVIDER_FORBIDDEN = [
  /\byou (?:have|are suffering from|are diagnosed with)\b/i,
  /\bdiagnos(?:is|ed)\b/i,
  /\b(?:take|use) \d+(?:\.\d+)?\s*(?:mg|ml|mcg)\b/i,
  /\b\d+\s*(?:mg|ml)\b/i,
  /\bstop taking\b/i,
  /\bprescrib(?:e|ed)\b/i,
  /\bno need to (?:see|consult)\b/i,
  /\bit is (?:harmless|not serious)\b/i,
  /\bnothing to worry about\b/i,
  /\bno need to worry\b/i,
  /\bguarantee\b/i,
  /\bcall \d{3,}\b/, // the model must not invent an emergency number
] as const;

/** True when the model's output is safe to show. Conservative by design. */
export function validateProviderOutput(text: string, emergencyContact?: string): { ok: boolean; reason?: string } {
  if (!text || text.trim().length < 2) return { ok: false, reason: "empty response" };
  if (text.length > 2000) return { ok: false, reason: "response too long" };
  for (const pattern of PROVIDER_FORBIDDEN) {
    if (pattern.test(text)) return { ok: false, reason: `matched ${pattern}` };
  }
  // The model may mention 112 when the local answer did, and no other number.
  const numbers = text.match(/\b\d{3,}\b/g) ?? [];
  for (const n of numbers) {
    if (emergencyContact && n === emergencyContact) continue;
    return { ok: false, reason: `unexpected number ${n}` };
  }
  if (!/consult/i.test(text)) return { ok: false, reason: "missing the referral" };
  return { ok: true };
}

export interface ProviderResult {
  text: string | null;
  used: boolean;
  /** Why the provider was not used, when it was not. */
  fallbackReason?: string;
}

/**
 * Asks the provider to rephrase, and refuses anything unsafe.
 *
 * Every failure path returns `text: null` with a reason. The caller then uses
 * the local answer unchanged — a degraded assistant is fine, a blocked one is
 * not.
 */
export async function rephraseWithProvider(
  localAnswer: string,
  userQuestion: string,
  opts: { emergencyContact?: string } = {}
): Promise<ProviderResult> {
  const config = providerConfig();
  if (!config) return { text: null, used: false, fallbackReason: "not configured" };

  // Never in an emergency. The local answer there is short and already correct;
  // there is nothing a rewrite improves and something it could break.
  if (opts.emergencyContact) {
    return { text: null, used: false, fallbackReason: "emergency answers never go through a model" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(config.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // Server-side only. Never NEXT_PUBLIC_, never sent to the browser.
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 600,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You reformat health information for readability. You are not a doctor. Never diagnose, never " +
              "name a medicine, never give a dose or duration, never tell anyone to stop a treatment, and " +
              "never remove the instruction to consult a qualified professional.",
          },
          {
            role: "user",
            content:
              `Question:\n${redactForProvider(userQuestion)}\n\n` +
              `Rewrite this answer clearly and warmly. Add nothing. Keep every warning and the closing ` +
              `line advising consultation.\n\n${localAnswer.slice(0, config.maxOutputChars)}`,
          },
        ],
      }),
    });
    if (!res.ok) return { text: null, used: false, fallbackReason: `provider returned ${res.status}` };

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      content?: string;
    };
    const text = json.choices?.[0]?.message?.content ?? json.content ?? "";
    const check = validateProviderOutput(text, opts.emergencyContact);
    if (!check.ok) return { text: null, used: false, fallbackReason: `rejected: ${check.reason}` };
    return { text, used: true };
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "provider timed out" : "provider unreachable";
    return { text: null, used: false, fallbackReason: reason };
  } finally {
    clearTimeout(timer);
  }
}