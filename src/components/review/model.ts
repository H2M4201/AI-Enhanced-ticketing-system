import type { RunStatus } from "@/components/run/types";
import type { DraftItem, ItemKind } from "@/core/domain";
import { activeItems } from "@/core/tree";

/** Add, delete, move, Accept and Reject are allowed only while the draft is under review. */
export function canChangeStructure(status: RunStatus): boolean {
  return status === "review";
}

/** Text and assignee edits: under review, or while creating for an item that has no Jira key yet. */
export function canEditItem(status: RunStatus, item: DraftItem): boolean {
  return (status === "review" || status === "creating") && item.jiraKey === null;
}

/** Regenerate replaces the whole draft, so it is offered only while no item exists in Jira. */
export function canRegenerate(status: RunStatus, items: DraftItem[]): boolean {
  return status === "review" && items.every((item) => item.jiraKey === null);
}

/** The kind a new child must have: a story under the epic, a task under a story. */
export function childKindOf(kind: ItemKind): "story" | "task" | null {
  if (kind === "epic") return "story";
  if (kind === "story") return "task";
  return null;
}

/** Same rule as the blockers: a non-epic item with no routing, or a routing that needs a decision. */
export function needsRouting(item: DraftItem): boolean {
  return item.kind !== "epic" && (item.routing === null || item.routing.status === "needs_decision");
}

/** The Jira browse link for a key, or null when the site URL is missing or is not http(s). */
export function keyUrl(siteUrl: string | null, key: string): string | null {
  if (siteUrl === null || !/^https?:\/\//i.test(siteUrl)) return null;
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** Children of each parent id (null for the root), in position order. */
export function childrenByParent(items: DraftItem[]): Map<string | null, DraftItem[]> {
  const map = new Map<string | null, DraftItem[]>();
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    const list = map.get(item.parentId) ?? [];
    list.push(item);
    map.set(item.parentId, list);
  }
  return map;
}

/** The ids of an item's descendants. The item itself is not included. */
export function descendantIds(items: DraftItem[], id: string): Set<string> {
  const children = childrenByParent(items);
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

/**
 * The ids the AI filter keeps: every AI suggestion with its ancestors and descendants.
 * Null when the filter is off, so every item shows.
 */
export function aiFilterIds(items: DraftItem[], aiOnly: boolean): Set<string> | null {
  if (!aiOnly) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  const keep = new Set<string>();
  for (const item of items) {
    if (item.origin !== "ai_suggestion") continue;
    keep.add(item.id);
    for (const id of descendantIds(items, item.id)) keep.add(id);
    let parent = item.parentId;
    while (parent !== null && byId.has(parent)) {
      keep.add(parent);
      parent = byId.get(parent)!.parentId;
    }
  }
  return keep;
}

/**
 * The items an item can be moved under: stories for a task, the epic for a story. Rejected
 * suggestions are not offered, and neither is the item's current parent.
 */
export function validParentsFor(items: DraftItem[], item: DraftItem): DraftItem[] {
  const wanted = item.kind === "task" ? "story" : item.kind === "story" ? "epic" : null;
  if (wanted === null) return [];
  return activeItems(items).filter((parent) => parent.kind === wanted && parent.id !== item.parentId);
}

/** Counts of the active (not rejected) items by kind. */
export function countKinds(items: DraftItem[]): { epics: number; stories: number; tasks: number } {
  const active = activeItems(items);
  return {
    epics: active.filter((item) => item.kind === "epic").length,
    stories: active.filter((item) => item.kind === "story").length,
    tasks: active.filter((item) => item.kind === "task").length,
  };
}

/** Active items that do not exist in Jira yet: what Create would make. */
export function uncreated(items: DraftItem[]): DraftItem[] {
  return activeItems(items).filter((item) => item.jiraKey === null);
}

/** Active items whose last create attempt failed: what Retry would make. */
export function failedItems(items: DraftItem[]): DraftItem[] {
  return activeItems(items).filter((item) => item.createError !== null);
}
