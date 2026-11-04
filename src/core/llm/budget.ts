const CHARS_PER_TOKEN = 4;
const RESERVED_TOKENS = 8000;

/** Rough token estimate: ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Checks that the combined inputs fit within the model's context minus a fixed reserve. */
export function checkContextBudget(
  parts: string[],
  contextTokens: number,
): { ok: boolean; estimated: number; limit: number } {
  const estimated = estimateTokens(parts.join(""));
  const limit = contextTokens - RESERVED_TOKENS;
  return { ok: estimated <= limit, estimated, limit };
}
