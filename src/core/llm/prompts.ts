import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptName = "structure" | "roster" | "clarify" | "draft" | "route";

const DEFAULT_DIR = join(process.cwd(), "src", "core", "llm", "prompts");
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Loads `<dir>/<name>.md` and replaces each `{{var}}` with its value.
 * Throws if a placeholder in the template has no matching variable.
 * Substituted values are not rescanned, so document text cannot trigger the check.
 */
export function renderPrompt(
  name: PromptName,
  vars: Record<string, string>,
  dir: string = DEFAULT_DIR,
): string {
  const template = readFileSync(join(dir, `${name}.md`), "utf8");
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
