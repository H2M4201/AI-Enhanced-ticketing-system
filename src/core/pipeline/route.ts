import { z } from "zod";
import { type DraftItem, type Routing, type RosterRule } from "@/core/domain";
import type { LlmClient } from "@/core/llm/client";
import { escapeAttribute, escapeTagBody } from "@/core/llm/escape";
import { renderPromptMessages } from "@/core/llm/prompts";
import { generateValidated } from "@/core/llm/structured";
import { normalizeName, type ResolvedRoster } from "@/core/pipeline/roster";
import type { AssignableUser, ProjectMeta } from "@/core/ticketing/adapter";

const DESCRIPTION_LIMIT = 300;
const REASON_LIMIT = 300;
const NO_RULE_REASON = "No routing rule matched";

/** Model reply: the model picks a rule id and reason per item. Everything else comes from the roster. */
const RouteReplySchema = z.object({
  assignments: z.array(
    z.object({
      itemId: z.string(),
      ruleId: z.string().nullable(),
      reason: z.string().nullish(),
    }),
  ),
});

type Pick = { ruleId: string | null; reason?: string | null };

/** Only stories and tasks are routed. Overridden routing is kept as the user set it. */
function isRoutable(item: DraftItem): boolean {
  return (item.kind === "story" || item.kind === "task") && item.routing?.overridden !== true;
}

/** Escapes text for the item and rule blocks, so it cannot close the wrapper tags or its own item. */
function escapeBlockText(text: string): string {
  return escapeTagBody(escapeTagBody(escapeTagBody(text, "item"), "items"), "rules");
}

function formatItems(targets: DraftItem[], all: DraftItem[]): string {
  const titles = new Map(all.map((item) => [item.id, item.title]));
  const body = targets
    .map((item) => {
      const lines = [
        `Title: ${item.title}`,
        `Description: ${item.description.slice(0, DESCRIPTION_LIMIT)}`,
      ];
      if (item.kind === "task" && item.parentId !== null) {
        const parent = titles.get(item.parentId);
        if (parent !== undefined) lines.push(`Parent story: ${parent}`);
      }
      return `<item id="${escapeAttribute(item.id)}" kind="${item.kind}">\n${escapeBlockText(lines.join("\n"))}\n</item>`;
    })
    .join("\n");
  return `<items>\n${body}\n</items>`;
}

function formatRules(rules: RosterRule[]): string {
  const lines = rules.map((rule) => {
    const target = `${rule.target.type} ${rule.target.name}`;
    return `${rule.id} (line ${rule.line}): ${escapeBlockText(rule.quote)} → ${escapeBlockText(target)}`;
  });
  return `<rules>\n${lines.join("\n")}\n</rules>`;
}

/** Collapses whitespace and caps the length. Returns null when nothing is left. */
function cleanReason(reason: string | null | undefined): string | null {
  const collapsed = (reason ?? "").replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed.slice(0, REASON_LIMIT);
}

function needsDecision(reason: string, teamName: string | null, ruleId: string | null): Routing {
  return {
    status: "needs_decision",
    accountId: null,
    displayName: null,
    teamName,
    reason,
    ruleId,
    ruleQuote: null,
    ruleLine: null,
    overridden: false,
  };
}

function assigned(
  user: AssignableUser,
  rule: RosterRule,
  teamName: string | null,
  reason: string,
): Routing {
  return {
    status: "assigned",
    accountId: user.accountId,
    displayName: user.displayName,
    teamName,
    reason,
    ruleId: rule.id,
    ruleQuote: rule.quote,
    ruleLine: rule.line,
    overridden: false,
  };
}

/** Turns the model's pick into a routing, checking it against the roster. */
function routingFor(pick: Pick | undefined, roster: ResolvedRoster): Routing {
  const rule = pick?.ruleId ? roster.rules.find((r) => r.id === pick.ruleId) : undefined;
  if (!rule) return needsDecision(NO_RULE_REASON, null, null);

  const reason = cleanReason(pick?.reason) ?? `Matched rule ${rule.id}`;
  const targetKey = normalizeName(rule.target.name);

  if (rule.target.type === "person") {
    const user: AssignableUser | undefined = roster.accounts[targetKey];
    if (!user) {
      return needsDecision(`Rule ${rule.id} names "${rule.target.name}", who isn't a resolved Jira user`, null, rule.id);
    }
    return assigned(user, rule, null, reason);
  }

  const team = roster.teams.find((t) => normalizeName(t.name) === targetKey);
  const teamName = team?.name ?? rule.target.name;
  const user: AssignableUser | null | undefined = team ? roster.teamDefaults[team.name] : null;
  if (!user) {
    return needsDecision(`Team "${teamName}" has no resolved default person`, teamName, rule.id);
  }
  return assigned(user, rule, teamName, reason);
}

/**
 * Routes each story and task to a person by asking the model which roster rule applies.
 * The model returns only a rule id and a reason. The assignee, team and quote come from the roster.
 * Epics, overridden items and items with no reply are handled as described on routingFor.
 */
export async function routeItems(
  llm: LlmClient,
  args: { items: DraftItem[]; roster: ResolvedRoster },
): Promise<DraftItem[]> {
  const { items, roster } = args;
  const targets = items.filter(isRoutable);
  if (targets.length === 0) return items;

  const messages = renderPromptMessages("route", {
    items: formatItems(targets, items),
    rules: formatRules(roster.rules),
  });
  const reply = await generateValidated(
    llm,
    RouteReplySchema,
    messages,
    { step: "route" },
  );

  const picks = new Map<string, Pick>();
  for (const assignment of reply.assignments) {
    if (!picks.has(assignment.itemId)) picks.set(assignment.itemId, assignment);
  }

  return items.map((item) => (isRoutable(item) ? { ...item, routing: routingFor(picks.get(item.id), roster) } : item));
}

/** The Jira component for a routed item: the one whose name equals its team, case-insensitively. */
export function componentIdsFor(item: DraftItem, meta: ProjectMeta): string[] {
  const team = item.routing?.teamName;
  if (!team) return [];
  const wanted = team.toLowerCase();
  const component = meta.components.find((c) => c.name.toLowerCase() === wanted);
  return component ? [component.id] : [];
}
