import { describe, expect, it } from "vitest";
import type { DraftItem, Routing } from "@/core/domain";
import { CreateBlockedError, createInTicketing, runLabel } from "@/core/pipeline/create";
import type { ResolvedStructure } from "@/core/pipeline/structure";
import { validateStructure } from "@/core/pipeline/structure";
import type { ProjectMeta } from "@/core/ticketing/adapter";
import { readMarker, markerFooter } from "@/core/ticketing/adapter";
import { fakeFromSample } from "../helpers/fake-ticketing";
import { mk } from "../helpers/draft";

type CreateArgs = Parameters<typeof createInTicketing>[0];

const runId = "abcdef1234567890";
const label = runLabel(runId);
const NO_FIELDS = { epic: [], story: [], task: [] };

function routed(accountId: string, teamName: string | null = null): Routing {
  return {
    status: "assigned",
    accountId,
    displayName: accountId,
    teamName,
    reason: "test",
    ruleId: "R1",
    ruleQuote: "test rule",
    ruleLine: 1,
    overridden: false,
  };
}

function structureFor(meta: ProjectMeta, taskType: string, taskLinkType = "Relates"): ResolvedStructure {
  const result = validateStructure(
    { specified: true, epicType: "Epic", storyType: "Story", taskType, taskLinkType, notes: [] },
    meta,
  );
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.resolved;
}

/** Epic, two stories (st2 is an accepted AI suggestion) and three tasks. */
function sampleItems(): DraftItem[] {
  return [
    mk({ id: "epic", kind: "epic", title: "Checkout Revamp", description: "One-page checkout." }),
    mk({
      id: "st1",
      kind: "story",
      parentId: "epic",
      position: 0,
      title: "Save card for later",
      description: "As a shopper, I want to save a card.",
      acceptanceCriteria: ["Save card checkbox is visible when signed in"],
      sourceRefs: ["requirements.md §2.1"],
      routing: routed("acc-linh", "Payments"),
    }),
    mk({
      id: "st2",
      kind: "story",
      parentId: "epic",
      position: 1,
      title: "Payment timeout handling",
      description: "Show the timeout message when payment times out.",
      acceptanceCriteria: ["Timeout message shown"],
      sourceRefs: ["requirements.md §2.1"],
      origin: "ai_suggestion",
      suggestionStatus: "accepted",
      routing: routed("acc-bao"),
    }),
    mk({
      id: "tk1",
      kind: "task",
      parentId: "st1",
      position: 0,
      title: "Hide save-card checkbox for guests",
      routing: routed("acc-bao"),
    }),
    mk({ id: "tk2", kind: "task", parentId: "st1", position: 1, title: "QA: save a card", routing: routed("acc-mai") }),
    mk({
      id: "tk3",
      kind: "task",
      parentId: "st2",
      position: 0,
      title: "Show timeout message on payment step",
      origin: "ai_suggestion",
      suggestionStatus: "accepted",
      routing: routed("acc-quang"),
    }),
  ];
}

/**
 * Runs createInTicketing against the fake adapter. The in-memory "db" applies the
 * callbacks to its items, so a later run sees the keys saved by an earlier one.
 */
function setup(initial: DraftItem[] = sampleItems()) {
  const fake = fakeFromSample();
  const db = {
    items: initial,
    clarificationsWritten: false,
    errors: {} as Record<string, string>,
  };
  const run = (overrides: Partial<CreateArgs> = {}) => {
    const existingEpicKey = db.items.find((i) => i.kind === "epic")?.jiraKey ?? null;
    return createInTicketing({
      adapter: fake,
      meta: fake.projectMeta,
      projectKey: "CHK",
      runId,
      items: db.items,
      structure: structureFor(fake.projectMeta, "Sub-task"),
      existingEpicKey,
      clarificationsText: "",
      clarificationsWritten: db.clarificationsWritten,
      acceptedByName: "Linh Tran",
      requiredFields: NO_FIELDS,
      onItemCreated: async (id, key) => {
        db.items = db.items.map((i) => (i.id === id ? { ...i, jiraKey: key, createError: null } : i));
      },
      onItemFailed: async (id, error) => {
        db.errors[id] = error;
        db.items = db.items.map((i) => (i.id === id ? { ...i, createError: error } : i));
      },
      onClarificationsWritten: async () => {
        db.clarificationsWritten = true;
      },
      ...overrides,
    });
  };
  return { fake, db, run };
}

function issueNamed(fake: ReturnType<typeof fakeFromSample>, summary: string) {
  const issue = fake.issues.find((i) => i.summary === summary);
  if (!issue) throw new Error(`No issue titled ${summary}`);
  return issue;
}

describe("createInTicketing", () => {
  it("creates epic → stories → sub-tasks with labels, assignee, components and marker", async () => {
    const { fake, run } = setup();
    await run();

    const epic = issueNamed(fake, "Checkout Revamp");
    expect(epic.issueTypeName).toBe("Epic");
    expect(readMarker(epic.description)).toBe("epic");

    const story = issueNamed(fake, "Save card for later");
    expect(story.parentKey).toBe(epic.key);
    expect(story.labels).toEqual(["ai-backlog", label]);
    expect(readMarker(story.description)).toBe("st1");
    expect(story.assigneeAccountId).toBe("acc-linh");
    expect(story.componentIds).toEqual(["c4"]);

    const task = issueNamed(fake, "Hide save-card checkbox for guests");
    expect(task.issueTypeName).toBe("Sub-task");
    expect(task.parentKey).toBe(story.key);
    expect(task.assigneeAccountId).toBe("acc-bao");
    expect(fake.links).toHaveLength(0);
  });

  it("sends the estimate in the story-points field when the project has one", async () => {
    const items = sampleItems().map((i) => (i.id === "st1" ? { ...i, estimate: 5 } : i));
    const { fake, run } = setup(items);
    const meta: ProjectMeta = {
      ...fake.projectMeta,
      issueTypes: fake.projectMeta.issueTypes.map((t) =>
        t.name === "Story" ? { ...t, estimateFieldKey: "customfield_10016" } : t,
      ),
    };
    await run({ meta });

    const story = issueNamed(fake, "Save card for later");
    expect(story.fieldValues).toEqual({ customfield_10016: 5 });
    expect(story.description).not.toContain("Estimate:");
  });

  it("writes the estimate into the description, before the marker, when there is no story-points field", async () => {
    const items = sampleItems().map((i) => (i.id === "st1" ? { ...i, estimate: 3 } : i));
    const { fake, run } = setup(items);
    await run();

    const story = issueNamed(fake, "Save card for later");
    expect(story.fieldValues).toEqual({});
    const lines = story.description.split("\n").filter((l) => l !== "");
    expect(lines.at(-2)).toBe("Estimate: 3 points");
    expect(readMarker(story.description)).toBe("st1");
    expect(issueNamed(fake, "Payment timeout handling").description).not.toContain("Estimate:");
  });

  it("labels accepted AI suggestions and prefixes the description", async () => {
    const { fake, run } = setup();
    await run();

    const story = issueNamed(fake, "Payment timeout handling");
    expect(story.labels).toEqual(["ai-backlog", label, "ai-suggested"]);
    expect(story.description).toBe(
      [
        "Proposed by AI and accepted by Linh Tran.",
        "Show the timeout message when payment times out.",
        "Acceptance criteria:\n- [ ] Timeout message shown",
        "Sources: requirements.md §2.1",
        markerFooter("st2"),
      ].join("\n\n"),
    );
  });

  it("one failed item does not stop others; retry creates only the failed one", async () => {
    const { fake, db, run } = setup();
    fake.failNext.set("tk1", "User cannot be assigned");

    const first = await run();
    expect(db.errors.tk1).toMatch(/cannot be assigned/);
    expect(first).toEqual({ created: 5, failed: 1, skipped: 0 });

    fake.failNext.delete("tk1");
    const before = fake.issues.length;
    const second = await run();
    expect(fake.issues.length).toBe(before + 1);
    expect(issueNamed(fake, "Hide save-card checkbox for guests").key).toBeTruthy();
    expect(second).toEqual({ created: 1, failed: 0, skipped: 5 });
  });

  it("a failed story fails its tasks with 'Parent was not created' and creates the rest", async () => {
    const { fake, db, run } = setup();
    fake.failNext.set("st1", "Story rejected");

    const summary = await run();
    expect(summary).toEqual({ created: 3, failed: 3, skipped: 0 });
    expect(db.errors.st1).toBe("Story rejected");
    expect(db.errors.tk1).toBe("Parent was not created");
    expect(db.errors.tk2).toBe("Parent was not created");
    expect(fake.issues.some((i) => i.summary === "Show timeout message on payment step")).toBe(true);
  });

  it("no duplicates when the process crashed after Jira created the issue", async () => {
    const { fake, db, run } = setup();
    fake.failAfterCreate.add("st1");

    await expect(run()).rejects.toThrow(/Simulated crash/);
    const second = await run();

    expect(fake.issues.filter((i) => i.summary === "Save card for later")).toHaveLength(1);
    expect(fake.issues.filter((i) => i.issueTypeName === "Epic")).toHaveLength(1);
    expect(db.items.every((i) => i.jiraKey !== null)).toBe(true);
    expect(second).toEqual({ created: 4, failed: 0, skipped: 2 });
  });

  it("appends clarifications to an existing epic exactly once", async () => {
    const { fake, db, run } = setup([mk({ id: "epic", kind: "epic", title: "Checkout Revamp", description: "One-page checkout." })]);

    await run({ clarificationsText: "" });
    expect(db.clarificationsWritten).toBe(false);

    const clarifications = "## Clarifications\n- Who pays shipping?";
    await run({ clarificationsText: clarifications });
    await run({ clarificationsText: clarifications });

    const epic = issueNamed(fake, "Checkout Revamp");
    expect(epic.description).toBe(`One-page checkout.\n\n${markerFooter("epic")}\n${clarifications}`);
    expect(db.clarificationsWritten).toBe(true);
  });

  it("does not append again when the clarifications are already in the epic after a crash", async () => {
    const { fake, db, run } = setup([mk({ id: "epic", kind: "epic", title: "Checkout Revamp", description: "One-page checkout." })]);
    await run();
    const epicKey = issueNamed(fake, "Checkout Revamp").key;

    // The crash came after the append but before the flag was saved.
    const clarifications = "## Clarifications\n- Who pays shipping?";
    await fake.appendToDescription(epicKey, `\n${clarifications}`);
    await run({ clarificationsText: clarifications });

    const epic = issueNamed(fake, "Checkout Revamp");
    expect(epic.description.split("## Clarifications")).toHaveLength(2);
    expect(db.clarificationsWritten).toBe(true);
  });

  it("writes clarifications into a newly created epic and marks them written", async () => {
    const { fake, db, run } = setup([mk({ id: "epic", kind: "epic", title: "Checkout Revamp", description: "One-page checkout." })]);

    await run({ clarificationsText: "## Clarifications\n- Who pays shipping?" });

    const epic = issueNamed(fake, "Checkout Revamp");
    expect(epic.description).toBe(`One-page checkout.\n\n## Clarifications\n- Who pays shipping?\n\n${markerFooter("epic")}`);
    expect(db.clarificationsWritten).toBe(true);
  });

  it("recovers an epic that crashed after creation without writing its clarifications twice", async () => {
    const { fake, db, run } = setup([mk({ id: "epic", kind: "epic", title: "Checkout Revamp", description: "One-page checkout." })]);
    const clarifications = "## Clarifications\n- Who pays shipping?";
    fake.failAfterCreate.add("epic");

    await expect(run({ clarificationsText: clarifications })).rejects.toThrow(/Simulated crash/);
    await run({ clarificationsText: clarifications });

    const epics = fake.issues.filter((i) => i.issueTypeName === "Epic");
    expect(epics).toHaveLength(1);
    expect(epics[0].description.split("## Clarifications")).toHaveLength(2);
    expect(db.clarificationsWritten).toBe(true);
  });

  it("does not require the epic's own fields when appending to an existing epic", async () => {
    const { fake, run } = setup();
    const seeded = await fake.createIssues([
      {
        clientRef: "x",
        projectKey: "CHK",
        issueTypeId: fake.projectMeta.issueTypes.find((t) => t.name === "Epic")!.id,
        summary: "Existing epic",
        description: "Old text.",
        labels: [],
      },
    ]);
    const key = (seeded[0] as { key: string }).key;
    const requiredFields = { ...NO_FIELDS, epic: [{ key: "customfield_9", name: "Budget" }] };

    const summary = await run({ existingEpicKey: key, requiredFields });

    expect(summary.failed).toBe(0);
    expect(fake.issues.filter((i) => i.issueTypeName === "Epic")).toHaveLength(1);
  });

  it("a link failure with an HTTP status keeps the task's key and reports the error", async () => {
    const { fake, db, run } = setup();
    const linkOf = fake.linkIssues.bind(fake);
    fake.linkIssues = async (fromKey, toKey, linkType) => {
      if (fake.issues.find((i) => i.key === fromKey)?.summary === "Hide save-card checkbox for guests") {
        throw Object.assign(new Error("Link type not allowed"), { status: 400 });
      }
      return linkOf(fromKey, toKey, linkType);
    };

    const summary = await run({ structure: structureFor(fake.projectMeta, "Task") });

    const failedTask = issueNamed(fake, "Hide save-card checkbox for guests");
    expect(summary).toEqual({ created: 5, failed: 1, skipped: 0 });
    expect(db.items.find((i) => i.id === "tk1")?.jiraKey).toBe(failedTask.key);
    expect(db.errors.tk1).toBe(
      `Created as ${failedTask.key} but linking to its story failed: Link type not allowed`,
    );
    expect(fake.links.map((l) => l.fromKey)).not.toContain(failedTask.key);
    expect(fake.links.map((l) => l.fromKey)).toContain(issueNamed(fake, "QA: save a card").key);
  });

  it.each([
    ["a network error", new Error("socket hang up")],
    ["an auth error", Object.assign(new Error("Unauthorized"), { status: 401 })],
  ])("rethrows %s from linking", async (_name, error) => {
    const { fake, run } = setup();
    fake.linkIssues = async () => {
      throw error;
    };

    await expect(run({ structure: structureFor(fake.projectMeta, "Task") })).rejects.toBe(error);
  });

  it("throws on an epic key mismatch before doing anything", async () => {
    const items = sampleItems().map((i) => (i.id === "epic" ? { ...i, jiraKey: "CHK-99" } : i));
    const { fake, run } = setup(items);

    await expect(run({ existingEpicKey: "CHK-1" })).rejects.toThrow(/Epic key mismatch/);
    expect(fake.issues).toHaveLength(0);
  });

  it("standard-level tasks parent to the epic and link to their story", async () => {
    const { fake, run } = setup();
    await run({ structure: structureFor(fake.projectMeta, "Task") });

    const epic = issueNamed(fake, "Checkout Revamp");
    const story = issueNamed(fake, "Save card for later");
    const task = issueNamed(fake, "Hide save-card checkbox for guests");
    expect(task.issueTypeName).toBe("Task");
    expect(task.parentKey).toBe(epic.key);
    expect(fake.links).toContainEqual({ fromKey: task.key, toKey: story.key, linkType: "Relates" });
  });

  it("skips linking when the project has no link types", async () => {
    const { fake, run } = setup();
    const structure = structureFor(fake.projectMeta, "Task");
    await run({ structure: { ...structure, plan: { ...structure.plan, taskLinkType: "" } } });

    expect(fake.links).toHaveLength(0);
    expect(issueNamed(fake, "Hide save-card checkbox for guests").parentKey).toBe(issueNamed(fake, "Checkout Revamp").key);
  });

  it("throws CreateBlockedError while blockers exist", async () => {
    const items = sampleItems().map((i) => (i.id === "st1" ? { ...i, routing: null } : i));
    const { fake, run } = setup(items);

    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreateBlockedError);
    expect((error as CreateBlockedError).blockers.map((b) => b.type)).toContain("needs_routing");
    expect(fake.issues).toHaveLength(0);
  });
});
