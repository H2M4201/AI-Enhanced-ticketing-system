import type { DraftItem } from "@/core/domain";

/** Builds a DraftItem with defaults; any field can be overridden. */
export function mk(partial: Partial<DraftItem> & Pick<DraftItem, "id" | "kind">): DraftItem {
  return {
    parentId: null,
    position: 0,
    title: `Item ${partial.id}`,
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
    ...partial,
  };
}

/** Recursively freezes a value so that any attempted mutation throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
