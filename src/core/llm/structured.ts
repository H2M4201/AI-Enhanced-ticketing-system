import type { z } from "zod";
import { safeLog } from "@/lib/log";
import type { ChatMessage, LlmClient } from "./client";

/** Thrown when the model does not produce valid, schema-conforming JSON within the attempt limit. */
export class LlmOutputError extends Error {
  constructor(
    readonly step: string,
    readonly attempts: number,
    readonly lastErrorSummary: string,
  ) {
    super(`LLM output for step "${step}" was invalid after ${attempts} attempts: ${lastErrorSummary}`);
    this.name = "LlmOutputError";
  }
}

const SUMMARY_MAX_LENGTH = 500;

/**
 * Pulls a JSON value out of a model reply: strips a ```json fence if present,
 * otherwise takes the span from the first `{`/`[` to the last matching `}`/`]`.
 * Throws SyntaxError when the result is not valid JSON.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[{[]/);
  let candidate = body;
  if (start >= 0) {
    const closer = body[start] === "{" ? "}" : "]";
    const end = body.lastIndexOf(closer);
    if (end > start) candidate = body.slice(start, end + 1);
  }
  return JSON.parse(candidate);
}

type ParseOutcome<T> = { ok: true; data: T } | { ok: false; summary: string };

function parseReply<T>(reply: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let raw: unknown;
  try {
    raw = extractJson(reply);
  } catch {
    // The parser message can quote the reply, so it is not forwarded.
    return { ok: false, summary: "Reply is not valid JSON (it may be truncated or wrapped in prose)." };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const summary = result.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "root"}: ${issue.message}`)
    .join("; ");
  return { ok: false, summary: summary.slice(0, SUMMARY_MAX_LENGTH) };
}

/**
 * Asks the model for JSON matching `schema`. On an unparseable or invalid reply,
 * the reply and the validation error are fed back and the model is asked again.
 * Logs attempt metadata only, never message or reply content.
 */
export async function generateValidated<T>(
  llm: LlmClient,
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts: { maxAttempts?: number; step?: string } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const step = opts.step ?? "unknown";
  const conversation = [...messages];
  let lastErrorSummary = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    let reply: string;
    try {
      reply = await llm.complete(conversation, { json: true });
    } catch (error) {
      safeLog("llm.attempt", { step, attempt, status: "error", model: llm.model, durationMs: Date.now() - started });
      throw error;
    }

    const outcome = parseReply(reply, schema);
    safeLog("llm.attempt", {
      step,
      attempt,
      status: outcome.ok ? "ok" : "invalid",
      model: llm.model,
      durationMs: Date.now() - started,
    });
    if (outcome.ok) return outcome.data;

    lastErrorSummary = outcome.summary;
    if (attempt < maxAttempts) {
      conversation.push(
        { role: "assistant", content: reply },
        {
          role: "user",
          content: `Your previous reply was invalid: ${lastErrorSummary}. Reply with only valid JSON matching the schema.`,
        },
      );
    }
  }

  throw new LlmOutputError(step, maxAttempts, lastErrorSummary);
}
