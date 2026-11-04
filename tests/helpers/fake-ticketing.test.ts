import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NewIssue } from "@/core/ticketing/adapter";
import { markerFooter, MARKER_PREFIX, readMarker } from "@/core/ticketing/adapter";
import { FakeSampleSchema, fakeFromSample, FakeTicketingAdapter } from "./fake-ticketing";

const SAMPLE_PATH = new URL("../../samples/fake-jira-project.json", import.meta.url);

function issue(clientRef: string, overrides: Partial<NewIssue> = {}): NewIssue {
  return {
    clientRef,
    projectKey: "CHK",
    issueTypeId: "2",
    summary: `Summary ${clientRef}`,
    description: `Description ${clientRef}\n\n${markerFooter(clientRef)}`,
    labels: ["ai-backlog"],
    ...overrides,
  };
}

describe("fake-jira-project.json sample", () => {
  it("parses against the sample schema", () => {
    const raw = JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
    const sample = FakeSampleSchema.parse(raw);
    expect(sample.projectMeta.key).toBe("CHK");
    expect(sample.projectMeta.issueTypes.map((t) => t.name)).toEqual([
      "Epic",
      "Story",
      "Task",
      "Bug",
      "Sub-task",
    ]);
    expect(sample.projectMeta.components.map((c) => c.name)).toEqual([
      "Frontend",
      "Backend",
      "QA",
      "Payments",
    ]);
    expect(sample.projectMeta.linkTypes).toEqual(["Relates", "Blocks"]);
    expect(sample.users).toHaveLength(7);
  });
});

describe("marker helpers", () => {
  it("uses the exact prefix and reads the last marker line", () => {
    expect(MARKER_PREFIX).toBe("ai-backlog-item: ");
    expect(markerFooter("x1")).toBe("ai-backlog-item: x1");
    expect(readMarker("no marker here")).toBeNull();
  });
});

describe("FakeTicketingAdapter", () => {
  it("fake adapter rejects unknown assignee per item", async () => {
    const f = fakeFromSample();
    const r = await f.createIssues([
      issue("a", { assigneeAccountId: "nobody" }),
      issue("b"),
    ]);
    expect(r[0]).toMatchObject({ ok: false, error: "User cannot be assigned" });
    expect(r[1]).toMatchObject({ ok: true });
    expect(f.issues).toHaveLength(1);
  });

  it("stores issues with CHK keys, issue type names and components", async () => {
    const f = fakeFromSample();
    const r = await f.createIssues([
      issue("epic", { issueTypeId: "1", componentIds: ["c1"] }),
      issue("story", { parentKey: "CHK-1", assigneeAccountId: "acc-linh" }),
    ]);
    expect(r).toEqual([
      { clientRef: "epic", ok: true, key: "CHK-1" },
      { clientRef: "story", ok: true, key: "CHK-2" },
    ]);
    expect(f.issues[0]).toMatchObject({ key: "CHK-1", issueTypeName: "Epic", componentIds: ["c1"] });
    expect(f.issues[1]).toMatchObject({ parentKey: "CHK-1", assigneeAccountId: "acc-linh" });
  });

  it("rejects a parent that does not exist", async () => {
    const f = fakeFromSample();
    const [r] = await f.createIssues([issue("a", { parentKey: "CHK-99" })]);
    expect(r).toMatchObject({ ok: false });
    expect(f.issues).toHaveLength(0);
  });

  it("failNext makes that clientRef fail without storing it", async () => {
    const f = fakeFromSample();
    f.failNext.set("a", "Jira is down");
    const r = await f.createIssues([issue("a"), issue("b")]);
    expect(r[0]).toEqual({ clientRef: "a", ok: false, error: "Jira is down" });
    expect(r[1]).toMatchObject({ ok: true });
    expect(f.issues.map((i) => i.summary)).toEqual(["Summary b"]);
  });

  it("failAfterCreate stores the issue and then throws", async () => {
    const f = fakeFromSample();
    f.failAfterCreate.add("a");
    await expect(f.createIssues([issue("a")])).rejects.toThrow(Error);
    expect(f.issues).toHaveLength(1);
    expect(f.issues[0].key).toBe("CHK-1");
  });

  it("findIssuesByLabel returns matching issues with their marker", async () => {
    const f = fakeFromSample();
    await f.createIssues([
      issue("a", { labels: ["ai-backlog", "ai-run-r1"] }),
      issue("b", { labels: ["other"] }),
    ]);
    expect(await f.findIssuesByLabel("CHK", "ai-run-r1")).toEqual([
      { key: "CHK-1", marker: "a" },
    ]);
  });

  it("getIssue returns the level from the issue type, or null when unknown", async () => {
    const f = fakeFromSample();
    await f.createIssues([issue("e", { issueTypeId: "1", summary: "Epic one" })]);
    expect(await f.getIssue("CHK-1")).toEqual({
      key: "CHK-1",
      summary: "Epic one",
      level: "epic",
      description: expect.any(String),
    });
    expect(await f.getIssue("CHK-404")).toBeNull();
  });

  it("appendToDescription appends to the stored description", async () => {
    const f = fakeFromSample();
    await f.createIssues([issue("e", { issueTypeId: "1" })]);
    await f.appendToDescription("CHK-1", "\n\n## Clarifications");
    expect(f.issues[0].description.endsWith("\n\n## Clarifications")).toBe(true);
  });

  it("canBrowseProject is true only for the sample key", async () => {
    const f = fakeFromSample();
    expect(await f.canBrowseProject("CHK")).toBe(true);
    expect(await f.canBrowseProject("NOPE")).toBe(false);
  });

  it("can be constructed directly from { projectMeta, users }", () => {
    const f = fakeFromSample();
    expect(new FakeTicketingAdapter({ projectMeta: f.projectMeta, users: f.users })).toBeInstanceOf(
      FakeTicketingAdapter,
    );
  });
});
