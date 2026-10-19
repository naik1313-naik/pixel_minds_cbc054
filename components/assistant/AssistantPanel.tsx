"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Pill, RotateCcw, Send, ShieldAlert, ShieldCheck, Stethoscope } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";
import AssistantText from "@/components/assistant/AssistantText";

/**
 * The MediMesh AI health assistant.
 *
 * Three things this screen is careful about:
 *
 *  1. **It never looks like a doctor.** No avatar, no "Dr" title, no stethoscope
 *     next to a diagnosis. The header says what it is, and every health answer
 *     carries its own referral line — the component cannot render an answer
 *     without one because the text comes with it.
 *  2. **Emergency guidance is styled differently and cannot be scrolled past.**
 *     It leads, it is red, and it names the number to call.
 *  3. **Catalogue results are only ever what the backend returned.** There is no
 *     fallback card, no placeholder, no "typically available in". If the
 *     database has nothing, the screen shows nothing.
 *
 * The conversation lives in component state only. Nothing is sent anywhere, and
 * "Clear conversation" empties it.
 */

interface CatalogueItem {
  id: number;
  display_name: string;
  generic_name: string;
  brand_name: string | null;
  dosage_form: string;
  category: string;
  requires_prescription: boolean;
  verification_status: string;
  price_paise: number;
  pharmacies: { id: number; name: string; free: number; price_paise: number }[];
  matchType: "exact" | "alternative" | "weak";
  differsBy: string | null;
}

interface Reply {
  intent: string;
  message: string;
  responseType: "general-information" | "health-information" | "pharmacy-search" | "emergency-guidance" | "clarifying-question" | "medical-refusal";
  catalogue?: CatalogueItem[];
  safetyNotice?: string;
  emergencyContact?: string;
  answeredBy: string;
  consultADoctor?: boolean;
  unsure?: boolean;
  data?: { nextQuestion?: string | null };
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  reply?: Reply;
}

const SUGGESTED = [
  "What should I know about fever?",
  "When should I seek medical help for a headache?",
  "What are common causes of a cough?",
  "How can I find a nearby pharmacy with a particular medicine?",
  "What information should I prepare before seeing a doctor?",
];

const STORAGE_KEY = "medimesh.assistant.conversation";

export default function AssistantPanel({ name }: { name: string }) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Restored on reload so a long triage conversation is not lost to a refresh.
  // Session-only in effect: nothing leaves the browser until the user sends a
  // message, and "Clear conversation" removes it.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) setTurns(JSON.parse(raw));
    } catch {
      /* unreadable storage is not worth failing the page over */
    }
  }, []);

  useEffect(() => {
    try {
      if (turns.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, [turns]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;

      setError("");
      setDraft("");
      // The assistant sees previous *user* turns only, so its own replies are
      // never replayed back into the question history.
      const history = turns.filter((t) => t.role === "user").map((t) => t.text);
      setTurns((prev) => [...prev, { role: "user", text: message }]);
      setBusy(true);

      try {
        const reply = await api.post<Reply>("/api/assistant", { message, history });
        setTurns((prev) => [...prev, { role: "assistant", text: reply.message, reply }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not reach the assistant");
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, turns]
  );

  function clear() {
    setTurns([]);
    setError("");
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    inputRef.current?.focus();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-teal-50 p-2 text-teal-700">
              <Stethoscope className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">MediMesh AI Health Assistant</h1>
              <p className="text-sm text-slate-500">Hello {name.split(" ")[0]} — ask in your own words.</p>
            </div>
          </div>
          {turns.length > 0 ? (
            <Button variant="ghost" onClick={clear}>
              <RotateCcw className="h-4 w-4" /> Clear conversation
            </Button>
          ) : null}
        </div>

        <div
          className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
          role="note"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <p className="text-sm leading-relaxed text-amber-900">
            <b>This is an AI health information assistant, not a doctor.</b> It can explain what a
            symptom is commonly associated with and tell you when to get help. It cannot diagnose,
            prescribe, or give a dose. It does not know your history, allergies or other medicines.
            Every health answer ends with advice to consult a qualified professional.
          </p>
        </div>
      </Card>

      <Card className="flex min-h-[26rem] flex-col p-0">
        <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
          {turns.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                Try one of these, or ask in your own words — including Hindi or a mix.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-sm text-slate-700 transition hover:border-teal-300 hover:bg-teal-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) => (
              <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
                {t.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-teal-600 px-4 py-2.5 text-sm text-white">
                    {t.text}
                  </div>
                ) : (
                  <AssistantBubble reply={t.reply!} onPick={(id) => router.push(`/?medicine=${id}`)} />
                )}
              </div>
            ))
          )}

          {busy ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span className="flex gap-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500"
                    style={{ animationDelay: `${i * 160}ms` }}
                  />
                ))}
              </span>
              Thinking…
            </div>
          ) : null}

          <div ref={endRef} />
        </div>

        {error ? (
          <div className="mx-5 mb-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}{" "}
            <button className="underline" onClick={() => void send(turns[turns.length - 1]?.text ?? "")}>
              Retry
            </button>
          </div>
        ) : null}

        <form
          className="flex items-end gap-2 border-t border-slate-100 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a newline. Expected in a chat box.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            maxLength={1000}
            aria-label="Message the assistant"
            placeholder="Describe what is bothering you, or ask about an order…"
            className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <Button type="submit" disabled={busy || draft.trim().length === 0}>
            <Send className="h-4 w-4" />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </Card>
    </div>
  );
}

function AssistantBubble({ reply, onPick }: { reply: Reply; onPick: (id: number) => void }) {
  const emergency = reply.responseType === "emergency-guidance";
  const refusal = reply.responseType === "medical-refusal";

  return (
    <div
      className={`max-w-[92%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-relaxed ${
        emergency
          ? "border border-rose-300 bg-rose-50 text-rose-900"
          : refusal
            ? "border border-amber-200 bg-amber-50 text-amber-950"
            : "bg-slate-50 text-slate-800"
      }`}
    >
      {emergency ? (
        <p className="mb-2 flex items-center gap-2 font-semibold">
          <AlertTriangle className="h-4 w-4" />
          {reply.emergencyContact
            ? `Emergency — call ${reply.emergencyContact} now`
            : "This needs urgent care"}
        </p>
      ) : refusal ? (
        // A refusal is not a failure and should not look like one. It gets its own
        // label so the reader can tell "I will not do this" from "I do not know".
        <p className="mb-2 flex items-center gap-2 font-semibold">
          <ShieldAlert className="h-4 w-4" />
          I will not answer that
        </p>
      ) : null}

      <AssistantText text={reply.message} />

      {reply.safetyNotice ? (
        <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-600">
          {reply.safetyNotice}
        </p>
      ) : null}

      {reply.catalogue && reply.catalogue.length > 0 ? (
        <div className="mt-3 space-y-2">
          {reply.catalogue.map((item) => (
            <div
              key={item.id}
              className={`rounded-lg border bg-white px-3 py-2 ${
                item.matchType === "alternative" ? "border-amber-200" : "border-slate-200"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{item.display_name}</span>
                {item.requires_prescription ? <Badge tone="amber">Rx</Badge> : null}
                {item.verification_status === "demo" ? <Badge tone="rose">demo data</Badge> : null}
                {item.matchType === "alternative" ? <Badge tone="amber">different {item.differsBy}</Badge> : null}
              </div>
              <p className="text-xs text-slate-500">
                {item.category} · {item.dosage_form}
              </p>
              {item.pharmacies.length ? (
                <ul className="mt-2 space-y-1">
                  {item.pharmacies.slice(0, 3).map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-xs text-slate-700">
                      <span>{p.name}</span>
                      <span className="flex items-center gap-3">
                        <span className="text-emerald-700">{p.free} in stock</span>
                        <span className="text-slate-500">{formatRupees(p.price_paise)}</span>
                        <button
                          className="text-teal-700 underline"
                          onClick={() => onPick(item.id)}
                        >
                          select
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-slate-400">Not stocked anywhere right now.</p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-slate-400">
        {reply.answeredBy.startsWith("provider") ? "answered via optional provider" : "answered locally"}
        {reply.unsure ? " · not confident" : ""}
      </p>
    </div>
  );
}