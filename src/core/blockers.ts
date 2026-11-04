import { activeItems } from "./tree";
import type { DraftItem, ItemKind } from "./domain";

export type Blocker = {
  itemId: string;
  type: "pending_suggestion" | "needs_routing" | "missing_field";
  message: string;
};

/**
 * Lists what stops the draft from being created in Jira. Only active items count,
 * and items that already have a Jira key are skipped. A required field counts as
 * missing when it is absent or null.
 */
export function computeBlockers(
  items: DraftItem[],
  requiredFields: Record<ItemKind, { key: string; name: string }[]>,
): Blocker[] {
  const blockers: Blocker[] = [];
  for (const item of activeItems(items)) {
    if (item.jiraKey !== null) continue;

    if (item.suggestionStatus === "pending") {
      blockers.push({
        itemId: item.id,
        type: "pending_suggestion",
        message: `"${item.title}" is an AI suggestion that still needs accepting or rejecting`,
      });
    }

    const needsRouting = item.kind !== "epic" && (item.routing === null || item.routing.status === "needs_decision");
    if (needsRouting) {
      blockers.push({
        itemId: item.id,
        type: "needs_routing",
        message: `"${item.title}" needs an assignee`,
      });
    }

    for (const field of requiredFields[item.kind]) {
      if (item.fieldValues[field.key] === undefined || item.fieldValues[field.key] === null) {
        blockers.push({
          itemId: item.id,
          type: "missing_field",
          message: `"${item.title}" is missing ${field.name}`,
        });
      }
    }
  }
  return blockers;
}
