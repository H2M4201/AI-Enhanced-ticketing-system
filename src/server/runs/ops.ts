import { z } from "zod";
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

/** Validates a DraftOp from a request body. Unknown keys are dropped, so an op cannot set fields it does not own. */
export const DraftOpSchema: z.ZodType<DraftOp> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), parentId: z.string(), kind: z.enum(["story", "task"]), title: z.string().min(1) }),
  z.object({ type: z.literal("delete"), id: z.string() }),
  z.object({ type: z.literal("move"), id: z.string(), newParentId: z.string() }),
  z.object({
    type: z.literal("update"),
    id: z.string(),
    patch: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      estimate: z.number().nullable().optional(),
      fieldValues: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({ type: z.literal("suggestion"), id: z.string(), status: z.enum(["accepted", "rejected"]) }),
  z.object({ type: z.literal("route"), id: z.string(), accountId: z.string() }),
]);

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
