import { describe, expect, it } from "vitest";
import type { Routing } from "@/core/domain";
import {
  activeItems,
  addItem,
  deleteItem,
  moveItem,
  overrideRouting,
  setSuggestionStatus,
  TreeError,
  updateItem,
  validateTree,
} from "@/core/tree";
import { deepFreeze, mk } from "../helpers/draft";

const epic = mk({ id: "e", kind: "epic", parentId: null });
const s1 = mk({ id: "s1", kind: "story", parentId: "e", position: 0 });
const s2 = mk({ id: "s2", kind: "story", parentId: "e", position: 1 });
const t1 = mk({ id: "t1", kind: "task", parentId: "s1", position: 0 });
const t2 = mk({ id: "t2", kind: "task", parentId: "s1", position: 1 });
const base = [epic, s1, s2, t1, t2];

const sugg = mk({ id: "g", kind: "story", parentId: "e", position: 2, origin: "ai_suggestion", suggestionStatus: "pending" });
const suggChild = mk({ id: "gt", kind: "task", parentId: "g", position: 0 });

const needsDecision: Routing = {
  status: "needs_decision",
  accountId: null,
  displayName: null,
  teamName: "Payments",
  reason: "Two candidates",
  ruleId: null,
  ruleQuote: null,
  ruleLine: null,
  overridden: false,
};

describe("validateTree", () => {
  it("accepts epic > story > task", () => {
    expect(() => validateTree(base)).not.toThrow();
  });

  it("rejects a task directly under the epic", () => {
    expect(() => validateTree([epic, mk({ id: "t", kind: "task", parentId: epic.id })])).toThrow(TreeError);
  });

  it("rejects a story under a story", () => {
    expect(() => validateTree([...base, mk({ id: "s3", kind: "story", parentId: "s1" })])).toThrow(TreeError);
  });

  it("rejects duplicate ids", () => {
    expect(() => validateTree([...base, mk({ id: "s1", kind: "story", parentId: "e" })])).toThrow(TreeError);
  });

  it("rejects a tree without exactly one epic", () => {
    expect(() => validateTree([s1, t1])).toThrow(TreeError);
    expect(() => validateTree([...base, mk({ id: "e2", kind: "epic", parentId: null })])).toThrow(TreeError);
  });

  it("rejects a story with no parent", () => {
    expect(() => validateTree([epic, mk({ id: "s9", kind: "story", parentId: null })])).toThrow(TreeError);
  });

  it("rejects a dangling parent reference", () => {
    expect(() => validateTree([epic, mk({ id: "s9", kind: "story", parentId: "missing" })])).toThrow(TreeError);
  });

  it("rejects an item that is its own parent (cycle)", () => {
    expect(() => validateTree([epic, mk({ id: "s1", kind: "story", parentId: "s1" })])).toThrow(TreeError);
  });
});

describe("addItem", () => {
  it("adds a story under the epic after the last sibling, as a from_docs item", () => {
    const { items, id } = addItem(base, { parentId: "e", kind: "story", title: "New story" });
    expect(items).toHaveLength(base.length + 1);
    expect(items.find((i) => i.id === id)).toMatchObject({
      parentId: "e",
      kind: "story",
      title: "New story",
      position: 2,
      origin: "from_docs",
      suggestionStatus: null,
      routing: null,
    });
  });

  it("adds a task under a story", () => {
    const { items, id } = addItem(base, { parentId: "s2", kind: "task", title: "Task" });
    expect(items.find((i) => i.id === id)).toMatchObject({ parentId: "s2", kind: "task", position: 0 });
  });

  it("rejects a task directly under the epic", () => {
    expect(() => addItem(base, { parentId: "e", kind: "task", title: "x" })).toThrow(TreeError);
  });

  it("rejects an unknown parent", () => {
    expect(() => addItem(base, { parentId: "nope", kind: "story", title: "x" })).toThrow(TreeError);
  });
});

describe("deleteItem", () => {
  it("removes the item and its descendants", () => {
    expect(deleteItem([epic, s1, t1], s1.id).map((i) => i.id)).toEqual([epic.id]);
  });

  it("refuses to delete the epic", () => {
    expect(() => deleteItem(base, "e")).toThrow(TreeError);
  });

  it("throws for an unknown id", () => {
    expect(() => deleteItem(base, "nope")).toThrow(TreeError);
  });
});

describe("moveItem", () => {
  it("moves a task under another story and renumbers both parents' children", () => {
    const items = moveItem(base, "t1", "s2");
    expect(items.find((i) => i.id === "t1")).toMatchObject({ parentId: "s2", position: 0 });
    expect(items.find((i) => i.id === "t2")).toMatchObject({ parentId: "s1", position: 0 });
  });

  it("refuses to move a story under a story", () => {
    expect(() => moveItem(base, "s2", "s1")).toThrow(TreeError);
  });

  it("refuses to move a task under the epic", () => {
    expect(() => moveItem(base, "t1", "e")).toThrow(TreeError);
  });

  it("refuses to move the epic", () => {
    expect(() => moveItem(base, "e", "s1")).toThrow(TreeError);
  });

  it("throws for an unknown item or parent", () => {
    expect(() => moveItem(base, "nope", "s1")).toThrow(TreeError);
    expect(() => moveItem(base, "t1", "nope")).toThrow(TreeError);
  });
});

describe("updateItem", () => {
  it("patches the allowed fields", () => {
    const items = updateItem(base, "s1", {
      title: "Renamed",
      description: "Desc",
      acceptanceCriteria: ["AC 1"],
      estimate: 5,
      fieldValues: { customfield_1: "Payments" },
    });
    expect(items.find((i) => i.id === "s1")).toMatchObject({
      title: "Renamed",
      description: "Desc",
      acceptanceCriteria: ["AC 1"],
      estimate: 5,
      fieldValues: { customfield_1: "Payments" },
    });
  });

  it("throws for an unknown id", () => {
    expect(() => updateItem(base, "nope", { title: "x" })).toThrow(TreeError);
  });
});

describe("setSuggestionStatus", () => {
  const withSugg = [...base, sugg, suggChild];

  it("accepts a pending suggestion", () => {
    const items = setSuggestionStatus(withSugg, "g", "accepted");
    expect(items.find((i) => i.id === "g")?.suggestionStatus).toBe("accepted");
  });

  it("rejects a suggestion", () => {
    const items = setSuggestionStatus(withSugg, "g", "rejected");
    expect(items.find((i) => i.id === "g")?.suggestionStatus).toBe("rejected");
  });

  it("throws when the item is not an AI suggestion", () => {
    expect(() => setSuggestionStatus(base, "s1", "accepted")).toThrow(TreeError);
  });
});

describe("overrideRouting", () => {
  it("assigns the user, marks it overridden and keeps the previous team", () => {
    const routed = [epic, mk({ id: "r", kind: "story", parentId: "e", routing: needsDecision })];
    const items = overrideRouting(routed, "r", { accountId: "acc-1", displayName: "Minh" });
    expect(items.find((i) => i.id === "r")?.routing).toEqual({
      status: "assigned",
      accountId: "acc-1",
      displayName: "Minh",
      teamName: "Payments",
      reason: "Set manually",
      ruleId: null,
      ruleQuote: null,
      ruleLine: null,
      overridden: true,
    });
  });

  it("throws for an unknown id", () => {
    expect(() => overrideRouting(base, "nope", { accountId: "a", displayName: "A" })).toThrow(TreeError);
  });
});

describe("activeItems", () => {
  it("drops a rejected suggestion and its descendants", () => {
    const items = [epic, sugg, suggChild];
    expect(activeItems(setSuggestionStatus(items, "g", "rejected")).map((i) => i.id)).toEqual([epic.id]);
  });

  it("keeps pending and accepted suggestions", () => {
    expect(activeItems([epic, sugg, suggChild]).map((i) => i.id)).toEqual(["e", "g", "gt"]);
  });
});

describe("operations never mutate their input", () => {
  it("runs every operation on a deeply frozen tree", () => {
    const snapshot = structuredClone([...base, sugg, suggChild]);
    const tree = deepFreeze(structuredClone([...base, sugg, suggChild]));

    expect(() => {
      addItem(tree, { parentId: "e", kind: "story", title: "x" });
      deleteItem(tree, "s1");
      moveItem(tree, "t1", "s2");
      updateItem(tree, "s1", { title: "renamed" });
      setSuggestionStatus(tree, "g", "accepted");
      overrideRouting(tree, "s1", { accountId: "a", displayName: "A" });
      activeItems(setSuggestionStatus(tree, "g", "rejected"));
      validateTree(tree);
    }).not.toThrow();

    expect(tree).toEqual(snapshot);
  });
});
