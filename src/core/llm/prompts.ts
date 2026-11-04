import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./client";

export type PromptName = "structure" | "roster" | "clarify" | "draft" | "route";

const DEFAULT_DIR = join(process.cwd(), "src", "core", "llm", "prompts");
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
/** A line of its own in a template: instructions above it, untrusted data blocks below it. */
export const DATA_MARKER = "---DATA---";

function substitute(name: string, template: string, vars: Record<string, string>): string {
  const missing = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    missing.add(key);
    return match;
  });
  if (missing.size > 0) {
    throw new Error(`Prompt "${name}" has unreplaced placeholders: ${[...missing].map((k) => `{{${k}}}`).join(", ")}`);
  }
  return rendered;
}

/**
 * Loads `<dir>/<name>.md`, splits it at the `---DATA---` line, and returns the instructions as a
 * `system` message and the data blocks as a `user` message. Each `{{var}}` is replaced with its value.
 * The split happens before substitution, and substituted values are not rescanned, so document text
 * can neither forge the marker nor trigger the missing-placeholder check.
 * Throws if the template lacks exactly one marker or a placeholder has no matching variable.
 */
export function renderPromptMessages(
  name: PromptName,
  vars: Record<string, string>,
  dir: string = DEFAULT_DIR,
): ChatMessage[] {
  const template = readFileSync(join(dir, `${name}.md`), "utf8");
  const parts = template.split(/^---DATA---[ \t]*\r?\n/m);
  if (parts.length !== 2) throw new Error(`Prompt "${name}" must contain exactly one ${DATA_MARKER} line`);
  return [
    { role: "system", content: substitute(name, parts[0], vars).trim() },
    { role: "user", content: substitute(name, parts[1], vars).trim() },
  ];
}
