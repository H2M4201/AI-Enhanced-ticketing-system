import type { DraftItem } from "@/core/domain";
import { addItem, deleteItem, moveItem, overrideRouting, setSuggestionStatus, TreeError, updateItem } from "@/core/tree";
import type { AssignableUser } from "@/core/ticketing/adapter";
import { RunStateError } from "@/server/errors";

export type DraftOp =
  | { type: "add"; parentId: string; kind: "story" | "task"; title: string }
  | { type: "delete"; id: string }
  | { type: "move"; id: string; newParentId: string }
  | {
      type: "update";
      id: string;
      patch: Partial<Pick<DraftItem, "title" | "description" | "acceptanceCriteria" | "estimate" | "fieldValues">>;
    }
  | { type: "suggestion"; id: string; status: "accepted" | "rejected" }
  | { type: "route"; id: string; accountId: string };

/** Structural changes (adding under, deleting or moving an item) are refused once an item exists in Jira. */
function assertNotCreated(items: DraftItem[], id: string, action: string): void {
  const item = items.find((i) => i.id === id);
  if (item?.jiraKey) {
    throw new RunStateError(`Cannot ${action} an item that already exists in Jira as ${item.jiraKey}`);
  }
}

/** Applies one edit to the draft and returns the new list. Throws TreeError or RunStateError when refused. */
export function applyDraftOp(items: DraftItem[], op: DraftOp, users: AssignableUser[]): DraftItem[] {
  switch (op.type) {
    case "add":
      assertNotCreated(items, op.parentId, "add a child to");
      return addItem(items, op).items;
    case "delete":
      assertNotCreated(items, op.id, "delete");
      return deleteItem(items, op.id);
    case "move":
      assertNotCreated(items, op.id, "move");
      return moveItem(items, op.id, op.newParentId);
    case "update":
      return updateItem(items, op.id, op.patch);
    case "suggestion":
      return setSuggestionStatus(items, op.id, op.status);
    case "route": {
      const user = users.find((u) => u.accountId === op.accountId);
      if (!user) throw new TreeError("Unknown user");
      return overrideRouting(items, op.id, user);
    }
  }
}
