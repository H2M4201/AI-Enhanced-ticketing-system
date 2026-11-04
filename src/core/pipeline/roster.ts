import { z } from "zod";
import { type Roster, type RosterRule } from "@/core/domain";
import type { LlmClient } from "@/core/llm/client";
import { renderPrompt } from "@/core/llm/prompts";
import { generateValidated } from "@/core/llm/structured";
import type { AssignableUser } from "@/core/ticketing/adapter";

/** Model reply: rule ids are assigned here, not by the model. */
const RosterReplySchema = z.object({
  teams: z.array(
    z.object({ name: z.string(), defaultPerson: z.string(), members: z.array(z.string()) }),
  ),
  people: z.array(z.object({ name: z.string(), role: z.string().nullish() })),
  rules: z.array(
    z.object({
      condition: z.string(),
      target: z.object({ type: z.enum(["person", "team"]), name: z.string() }),
      line: z.number(),
      quote: z.string(),
    }),
  ),
});

export type UnresolvedName = {
  name: string;
  reason: "not_found" | "ambiguous";
  suggestions: AssignableUser[];
};

export type ResolvedRoster = Roster & {
  accounts: Record<string /* normalized name */, AssignableUser>;
  unresolved: UnresolvedName[];
  teamDefaults: Record<string /* team name */, AssignableUser | null>;
};

const SUGGESTION_LIMIT = 3;

/** NFD, strip combining marks, map đ to d, lowercase, collapse whitespace. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(normalized: string): string[] {
  return normalized === "" ? [] : normalized.split(" ");
}

/** The email local part, with dots, underscores, pluses and hyphens read as spaces ("minh.nguyen" is "minh nguyen"). */
function emailLocalName(email: string | null): string | null {
  if (!email) return null;
  return normalizeName((email.split("@")[0] ?? "").replace(/[._+-]+/g, " "));
}

/** Keeps routing text from closing its own tag or breaking the file attribute. */
function escapeBody(content: string): string {
  return content.replace(/<\/routing/gi, "&lt;/routing");
}

function escapeAttribute(value: string): string {
  return value.replace(/["<>]/g, (c) => ({ '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

const stripWhitespace = (s: string): string => s.replace(/\s+/g, "");

/** The line the quote is on: the cited line if it holds the quote, else the first line that does, else null. */
function findQuoteLine(lines: string[], rule: { line: number; quote: string }): number | null {
  const quote = stripWhitespace(rule.quote);
  if (quote === "") return null;
  const cited = rule.line - 1;
  if (cited >= 0 && cited < lines.length && stripWhitespace(lines[cited]).includes(quote)) return rule.line;
  const found = lines.findIndex((line) => stripWhitespace(line).includes(quote));
  return found >= 0 ? found + 1 : null;
}

/**
 * Asks the model for the teams, people and routing rules in a routing file.
 * Each rule's quote is checked against the file: a wrong line number is corrected,
 * and a rule whose quote is not in the file is dropped. Rules get ids R1..Rn in file order.
 */
export async function parseRoster(
  llm: LlmClient,
  routingFile: { filename: string; content: string },
): Promise<Roster> {
  const lines = routingFile.content.split(/\r?\n/);
  const numbered = lines.map((line, i) => `${i + 1}| ${line}`).join("\n");
  const block = `<routing file="${escapeAttribute(routingFile.filename)}">\n${escapeBody(numbered)}\n</routing>`;
  const prompt = renderPrompt("roster", { routing: block });

  const reply = await generateValidated(
    llm,
    RosterReplySchema,
    [{ role: "system", content: prompt }],
    { step: "roster" },
  );

  const checked = reply.rules.flatMap((rule) => {
    const line = findQuoteLine(lines, rule);
    return line === null ? [] : [{ ...rule, line }];
  });
  checked.sort((a, b) => a.line - b.line);

  const rules: RosterRule[] = checked.map((rule, i) => ({
    id: `R${i + 1}`,
    condition: rule.condition,
    target: rule.target,
    line: rule.line,
    quote: rule.quote,
  }));

  return {
    teams: reply.teams,
    people: reply.people.map((p) => ({ name: p.name, role: p.role ?? null })),
    rules,
  };
}

type NameResult = { user: AssignableUser } | { unresolved: UnresolvedName };

/**
 * Exact matches (full display name or email local part) are accepted only when unique.
 * A query equal to the first or last token of users' display names is never accepted:
 * several such users make it ambiguous, one such user makes it not_found with that user as the suggestion.
 * Anything else is not_found, with the closest users by shared tokens.
 */
function resolveName(name: string, users: AssignableUser[]): NameResult {
  const key = normalizeName(name);
  if (key === "") return { unresolved: { name, reason: "not_found", suggestions: [] } };

  const exact = users.filter(
    (u) => normalizeName(u.displayName) === key || emailLocalName(u.email) === key,
  );
  if (exact.length === 1) return { user: exact[0] };
  if (exact.length > 1) return { unresolved: { name, reason: "ambiguous", suggestions: exact } };

  const edge = users.filter((u) => {
    const t = tokensOf(normalizeName(u.displayName));
    return t.length > 0 && (t[0] === key || t[t.length - 1] === key);
  });
  if (edge.length > 1) return { unresolved: { name, reason: "ambiguous", suggestions: edge } };
  if (edge.length === 1) return { unresolved: { name, reason: "not_found", suggestions: edge } };

  const wanted = new Set(tokensOf(key));
  const suggestions = users
    .map((u) => {
      const userTokens = new Set(tokensOf(normalizeName(u.displayName)));
      return { user: u, shared: [...userTokens].filter((t) => wanted.has(t)).length };
    })
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => s.user);
  return { unresolved: { name, reason: "not_found", suggestions } };
}

/** Resolves every name in the roster: people, team defaults, team members and person-targeted rules. */
export function resolveRoster(roster: Roster, users: AssignableUser[]): ResolvedRoster {
  const accounts: Record<string, AssignableUser> = {};
  const unresolved: UnresolvedName[] = [];
  const reported = new Set<string>();
  const resolvedByKey = new Map<string, AssignableUser | null>();

  const report = (entry: UnresolvedName, key: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    unresolved.push(entry);
  };

  const resolveOnce = (name: string): AssignableUser | null => {
    const key = normalizeName(name);
    const cached = resolvedByKey.get(key);
    if (cached !== undefined) return cached;
    const result = resolveName(name, users);
    if ("user" in result) {
      accounts[key] = result.user;
      resolvedByKey.set(key, result.user);
      return result.user;
    }
    report(result.unresolved, key);
    resolvedByKey.set(key, null);
    return null;
  };

  for (const person of roster.people) resolveOnce(person.name);

  const teamKeys = new Set(roster.teams.map((t) => normalizeName(t.name)));
  const teamDefaults: Record<string, AssignableUser | null> = {};
  for (const team of roster.teams) {
    teamDefaults[team.name] = resolveOnce(team.defaultPerson);
    for (const member of team.members) resolveOnce(member);
  }

  for (const rule of roster.rules) {
    if (rule.target.type === "person") {
      resolveOnce(rule.target.name);
    } else {
      const key = normalizeName(rule.target.name);
      if (!teamKeys.has(key)) report({ name: rule.target.name, reason: "not_found", suggestions: [] }, key);
    }
  }

  return { ...roster, accounts, unresolved, teamDefaults };
}
