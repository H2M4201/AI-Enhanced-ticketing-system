import type { DraftItem, ItemKind, Routing } from "./domain";

/** Thrown when a draft-tree operation would break the epic > story > task structure. */
export class TreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeError";
  }
}

const REQUIRED_PARENT_KIND: Record<"story" | "task", ItemKind> = {
  story: "epic",
  task: "story",
};

function findOrThrow(items: DraftItem[], id: string): DraftItem {
  const item = items.find((i) => i.id === id);
  if (!item) throw new TreeError(`Item not found: ${id}`);
  return item;
}

function assertParentAllowed(items: DraftItem[], parentId: string, kind: "story" | "task"): void {
  const parent = findOrThrow(items, parentId);
  if (parent.kind !== REQUIRED_PARENT_KIND[kind]) {
    throw new TreeError(`A ${kind} must sit under a ${REQUIRED_PARENT_KIND[kind]}, not a ${parent.kind}`);
  }
}

function nextPosition(items: DraftItem[], parentId: string): number {
  const siblings = items.filter((i) => i.parentId === parentId);
  return siblings.reduce((max, i) => Math.max(max, i.position), -1) + 1;
}

/** Reassigns 0..n-1 positions to the children of a parent, keeping their current order. */
function renumber(items: DraftItem[], parentId: string): DraftItem[] {
  const ordered = items
    .filter((i) => i.parentId === parentId)
    .sort((a, b) => a.position - b.position);
  const newPosition = new Map(ordered.map((item, index) => [item.id, index]));
  return items.map((i) => (newPosition.has(i.id) ? { ...i, position: newPosition.get(i.id)! } : i));
}

/** Collects an item's id plus the ids of all its descendants. */
function subtreeIds(items: DraftItem[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items) {
      if (i.parentId !== null && ids.has(i.parentId) && !ids.has(i.id)) {
        ids.add(i.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Checks the whole tree: one epic at the root, story under epic, task under story, unique ids, no cycles. */
export function validateTree(items: DraftItem[]): void {
  const ids = new Set<string>();
  for (const i of items) {
    if (ids.has(i.id)) throw new TreeError(`Duplicate item id: ${i.id}`);
    ids.add(i.id);
  }

  const epics = items.filter((i) => i.kind === "epic");
  if (epics.length !== 1) throw new TreeError(`Expected exactly one epic, found ${epics.length}`);
  if (epics[0].parentId !== null) throw new TreeError("The epic must not have a parent");

  const byId = new Map(items.map((i) => [i.id, i]));
  for (const i of items) {
    if (i.kind === "epic") continue;
    if (i.parentId === null) throw new TreeError(`${i.kind} ${i.id} has no parent`);
    const parent = byId.get(i.parentId);
    if (!parent) throw new TreeError(`${i.id} references missing parent ${i.parentId}`);
    if (i.kind === "story" || i.kind === "task") {
      if (parent.kind !== REQUIRED_PARENT_KIND[i.kind]) {
        throw new TreeError(`A ${i.kind} must sit under a ${REQUIRED_PARENT_KIND[i.kind]}, not a ${parent.kind}`);
      }
    }
    // Walk up to the root; a repeated id means a cycle.
    const seen = new Set<string>([i.id]);
    let cursor: DraftItem | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.id)) throw new TreeError(`Cycle detected at ${cursor.id}`);
      seen.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
  }
}

/** Adds a story under the epic, or a task under a story, as a from_docs item after its last sibling. */
export function addItem(
  items: DraftItem[],
  input: { parentId: string; kind: "story" | "task"; title: string },
): { items: DraftItem[]; id: string } {
  assertParentAllowed(items, input.parentId, input.kind);
  const id = crypto.randomUUID();
  const item: DraftItem = {
    id,
    parentId: input.parentId,
    position: nextPosition(items, input.parentId),
    kind: input.kind,
    title: input.title,
    description: "",
    acceptanceCriteria: [],
    estimate: null,
    sourceRefs: [],
    origin: "from_docs",
    assumption: false,
    shapedBy: [],
    suggestionStatus: null,
    routing: null,
    fieldValues: {},
    jiraKey: null,
    createError: null,
  };
  return { items: [...items, item], id };
}

/** Removes an item and all its descendants. The epic cannot be deleted. */
export function deleteItem(items: DraftItem[], id: string): DraftItem[] {
  const target = findOrThrow(items, id);
  if (target.kind === "epic") throw new TreeError("The epic cannot be deleted");
  const removed = subtreeIds(items, id);
  const remaining = items.filter((i) => !removed.has(i.id));
  return target.parentId === null ? remaining : renumber(remaining, target.parentId);
}

/** Moves an item (with its subtree) under a new parent, keeping the kind rules. Positions are renumbered on both sides. */
export function moveItem(items: DraftItem[], id: string, newParentId: string): DraftItem[] {
  const target = findOrThrow(items, id);
  if (target.kind === "epic") throw new TreeError("The epic cannot be moved");
  assertParentAllowed(items, newParentId, target.kind);

  const oldParentId = target.parentId;
  const moved = items.map((i) =>
    i.id === id ? { ...i, parentId: newParentId, position: nextPosition(items, newParentId) } : i,
  );
  const renumbered = renumber(moved, newParentId);
  return oldParentId === null || oldParentId === newParentId ? renumbered : renumber(renumbered, oldParentId);
}

/** Patches editable fields of an item. */
export function updateItem(
  items: DraftItem[],
  id: string,
  patch: Partial<Pick<DraftItem, "title" | "description" | "acceptanceCriteria" | "estimate" | "fieldValues">>,
): DraftItem[] {
  findOrThrow(items, id);
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}

/** Accepts or rejects an AI suggestion. Only AI suggestions carry a suggestion status. */
export function setSuggestionStatus(
  items: DraftItem[],
  id: string,
  status: "accepted" | "rejected",
): DraftItem[] {
  const target = findOrThrow(items, id);
  if (target.origin !== "ai_suggestion") throw new TreeError(`Item ${id} is not an AI suggestion`);
  return items.map((i) => (i.id === id ? { ...i, suggestionStatus: status } : i));
}

/** Assigns an item to a user by hand. The team from the previous routing is kept. */
export function overrideRouting(
  items: DraftItem[],
  id: string,
  user: { accountId: string; displayName: string },
): DraftItem[] {
  const target = findOrThrow(items, id);
  const routing: Routing = {
    status: "assigned",
    accountId: user.accountId,
    displayName: user.displayName,
    teamName: target.routing?.teamName ?? null,
    reason: "Set manually",
    ruleId: null,
    ruleQuote: null,
    ruleLine: null,
    overridden: true,
  };
  return items.map((i) => (i.id === id ? { ...i, routing } : i));
}

/** Returns the items that are not rejected suggestions, dropping each rejected suggestion's whole subtree. */
export function activeItems(items: DraftItem[]): DraftItem[] {
  const dropped = new Set<string>();
  for (const i of items) {
    if (i.suggestionStatus === "rejected") {
      for (const id of subtreeIds(items, i.id)) dropped.add(id);
    }
  }
  return items.filter((i) => !dropped.has(i.id));
}
