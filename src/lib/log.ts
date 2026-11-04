/**
 * Structured logging that cannot leak document content, prompts or model output.
 * Only allowlisted keys are written; string values are truncated.
 */
const ALLOWED_KEYS = [
  "runId",
  "projectId",
  "userId",
  "itemId",
  "count",
  "durationMs",
  "status",
  "step",
  "attempt",
  "errorCode",
  "httpStatus",
  "model",
] as const;

const MAX_STRING_LENGTH = 120;

type AllowedKey = (typeof ALLOWED_KEYS)[number];
export type LogMeta = Partial<Record<AllowedKey, string | number | boolean | null>>;

export function safeLog(event: string, meta: LogMeta = {}): void {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), event };
  for (const key of ALLOWED_KEYS) {
    const value = meta[key];
    if (value === undefined) continue;
    entry[key] = typeof value === "string" ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
