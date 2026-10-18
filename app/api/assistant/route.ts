import type { NextRequest } from "next/server";
import { z } from "zod";
import { guard, json, error, clientIp } from "@/lib/api-utils";
import { route, type AssistantActor } from "@/lib/assistant";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/assistant
 *
 * Answers from the caller's own session only. There is no parameter that could
 * name another user, which is what makes the ownership guarantee structural
 * rather than a promise.
 *
 * ## Logging
 *
 * Only the intent and response type are logged. The message itself is health
 * information that a person did not ask us to write down, and an audit log is
 * not the place for it.
 */

const schema = z.object({
  message: z.string().trim().min(1).max(1000),
  // Short transcript, so the triage flow can keep asking its questions.
  history: z.array(z.string().max(1000)).max(20).optional().default([]),
});

/**
 * Chat limit.
 *
 * Tighter than the login limiter on purpose: each call can read the database and,
 * when a provider is configured, make an outbound request. Twelve a minute is
 * generous for reading about a symptom and stops a script driving this endpoint.
 */
const CHAT_LIMIT = 12;
const CHAT_WINDOW_MS = 60_000;

export const POST = guard(null, async (ctx, req: NextRequest) => {
  const limited = await rateLimit(`assistant:${clientIp(req)}`, CHAT_LIMIT, CHAT_WINDOW_MS);
  if (!limited.ok) {
    return error(429, "Too many messages. Please wait a moment before sending more.", {
      retryAfterSeconds: limited.retryAfterSeconds,
    });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");

  const actor: AssistantActor = {
    userId: ctx.user.id,
    role: ctx.user.role,
    pharmacyId: ctx.user.pharmacy_id ?? null,
    name: ctx.user.name ?? "there",
  };

  const reply = await route(parsed.data.message, actor, parsed.data.history);

  // Metadata only. Never the message: it may describe somebody's symptoms.
  console.info(
    `assistant intent=${reply.intent} type=${reply.responseType} by=${reply.answeredBy} role=${ctx.user.role}`
  );

  return json(reply);
});