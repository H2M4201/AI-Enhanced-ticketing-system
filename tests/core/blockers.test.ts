import { describe, expect, it } from "vitest";
import { computeBlockers } from "@/core/blockers";
import type { ItemKind, Routing } from "@/core/domain";
import { mk } from "../helpers/draft";

const epic = mk({ id: "e", kind: "epic" });
const required: Record<ItemKind, { key: string; name: string }[]> = {
  epic: [],
  story: [{ key: "customfield_1", name: "Team" }],
  task: [],
};

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

const assigned: Routing = {
  status: "assigned",
  accountId: "acc-1",
  displayName: "Minh",
  teamName: "Payments",
  reason: "Rule matched",
  ruleId: "r1",
  ruleQuote: "Payments stories go to Minh",
  ruleLine: 3,
  overridden: false,
};

describe("computeBlockers", () => {
  it("flags pending suggestion, needs-decision routing and missing required field", () => {
    const b = computeBlockers(
      [
        epic,
        mk({
          id: "s",
          kind: "story",
          parentId: "e",
          origin: "ai_suggestion",
          suggestionStatus: "pending",
          routing: needsDecision,
        }),
      ],
      required,
    );
    expect(b.map((x) => x.type).sort()).toEqual(["missing_field", "needs_routing", "pending_suggestion"]);
    expect(b.every((x) => x.itemId === "s")).toBe(true);
  });

  it("flags a story or task with no routing as needs_routing", () => {
    const b = computeBlockers(
      [epic, mk({ id: "s", kind: "story", parentId: "e" }), mk({ id: "t", kind: "task", parentId: "s" })],
      { epic: [], story: [], task: [] },
    );
    expect(b.map((x) => [x.itemId, x.type])).toEqual([
      ["s", "needs_routing"],
      ["t", "needs_routing"],
    ]);
  });

  it("does not require routing for the epic", () => {
    expect(computeBlockers([epic], { epic: [], story: [], task: [] })).toEqual([]);
  });

  it("is satisfied when routing is assigned and the required field is set", () => {
    const b = computeBlockers(
      [
        epic,
        mk({
          id: "s",
          kind: "story",
          parentId: "e",
          routing: assigned,
          fieldValues: { customfield_1: "Payments" },
        }),
      ],
      required,
    );
    expect(b).toEqual([]);
  });

  it("treats a null required field value as missing", () => {
    const b = computeBlockers(
      [epic, mk({ id: "s", kind: "story", parentId: "e", routing: assigned, fieldValues: { customfield_1: null } })],
      required,
    );
    expect(b.map((x) => x.type)).toEqual(["missing_field"]);
  });

  it("ignores a rejected suggestion and its subtree", () => {
    const b = computeBlockers(
      [
        epic,
        mk({ id: "g", kind: "story", parentId: "e", origin: "ai_suggestion", suggestionStatus: "rejected" }),
        mk({ id: "gt", kind: "task", parentId: "g" }),
      ],
      required,
    );
    expect(b).toEqual([]);
  });

  it("ignores items that already have a Jira key", () => {
    const b = computeBlockers(
      [epic, mk({ id: "s", kind: "story", parentId: "e", jiraKey: "PROJ-1", suggestionStatus: "pending" })],
      required,
    );
    expect(b).toEqual([]);
  });
});
