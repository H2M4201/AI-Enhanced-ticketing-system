import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/core/llm/client";
import { CreateBlockedError } from "@/core/pipeline/create";
import { validateStructure } from "@/core/pipeline/structure";
import { TreeError } from "@/core/tree";
import { resetEnvCache } from "@/lib/env";
import { RunStateError } from "@/server/errors";
import { runs, users } from "@/server/db/schema";
import { activeFiles, createProject, uploadProjectFile } from "@/server/projects";
import { getRun, loadDraft, saveDraft, setItemCreated, setItemFailed } from "@/server/runs/repo";
import { RunService, type RunDeps } from "@/server/runs/service";
import { testDb } from "../helpers/db";
import { FakeLlm } from "../helpers/fake-llm";
import { fakeFromSample, type FakeTicketingAdapter } from "../helpers/fake-ticketing";
import { sampleDraftOutput } from "../helpers/sample-draft";
import { mk } from "../helpers/draft";

const SAMPLE_DIR = new URL("../../samples/checkout-revamp/", import.meta.url);
const sampleText = (name: string) => readFileSync(new URL(name, SAMPLE_DIR), "utf8");
const sampleBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, SAMPLE_DIR)));

const EPIC = "Replace the three-page checkout with a one-page checkout for guests and logged-in shoppers.";

const STRUCTURE_REPLY = JSON.stringify({
  specified: true,
  epicType: "Epic",
  storyType: "Story",
  taskType: "Sub-task",
  taskLinkType: "Relates",
  notes: [],
});

const ROSTER_REPLY = JSON.stringify({
  teams: [
    { name: "Frontend", defaultPerson: "Linh Tran", members: ["Linh Tran", "Minh Nguyen"] },
    { name: "Backend", defaultPerson: "Bao Le", members: ["Bao Le", "Minh Pham", "Nguyễn Văn An"] },
    { name: "QA", defaultPerson: "Mai Pham", members: ["Mai Pham"] },
    { name: "Payments", defaultPerson: "Quang Vo", members: ["Quang Vo"] },
  ],
  people: [
    { name: "Linh Tran", role: "Frontend lead" },
    { name: "Minh Nguyen", role: "Frontend developer" },
    { name: "Bao Le", role: "Backend lead" },
    { name: "Minh Pham", role: "Backend developer" },
    { name: "Nguyễn Văn An", role: "Backend developer" },
    { name: "Mai Pham", role: "QA lead" },
    { name: "Quang Vo", role: "Payments lead" },
  ],
  rules: [
    { condition: "payments or cards", target: { type: "team", name: "Payments" }, line: 22, quote: "Anything touching payments or cards → team Payments" },
    { condition: "QA sub-tasks", target: { type: "team", name: "QA" }, line: 23, quote: "QA sub-tasks → team QA" },
    { condition: "database migrations", target: { type: "person", name: "Bao Le" }, line: 24, quote: "Database migrations → Bao Le" },
    { condition: "cart or checkout UI", target: { type: "team", name: "Frontend" }, line: 25, quote: "Anything touching the cart, checkout page or order summary UI → team Frontend" },
    { condition: "API endpoints", target: { type: "team", name: "Backend" }, line: 26, quote: "API endpoints and order service changes → team Backend" },
    { condition: "confirmation emails", target: { type: "team", name: "Backend" }, line: 27, quote: "Order confirmation email templates → team Backend" },
    { condition: "saved card removal", target: { type: "team", name: "Payments" }, line: 28, quote: "Saved card removal in the account page → team Payments" },
  ],
});

const QUESTIONS_REPLY = JSON.stringify({
  questions: [
    {
      category: "contradiction",
      text: "Can guests save a card for later? Section 2.1 allows it, but section 3.2 says only logged-in users can save cards.",
      sourceRefs: ["requirements.md §2.1", "requirements.md §3.2"],
      rank: 1,
    },
    {
      category: "missing",
      text: "Is shipping always a fixed amount per order, or does it vary by destination?",
      sourceRefs: ["requirements.md §4.1"],
      rank: 2,
    },
  ],
});

/** Picks a routing rule per item from its title. Titles containing "timeout" get no rule, so they need a decision. */
function ruleFor(title: string): string | null {
  if (/timeout/i.test(title)) return null;
  if (title.startsWith("QA:")) return "R2";
  if (/email/i.test(title)) return "R6";
  if (/card/i.test(title)) return "R1";
  return "R4";
}

/** Route reply that reads the item ids and titles from the prompt, since the draft ids are generated. */
function routeReply(messages: ChatMessage[]): string {
  const prompt = messages.map((m) => m.content).join("\n");
  const assignments = [...prompt.matchAll(/<item id="([^"]+)" kind="\w+">\nTitle: (.*)/g)].map(([, itemId, title]) => ({
    itemId,
    ruleId: ruleFor(title),
    reason: "Chosen from the item title.",
  }));
  return JSON.stringify({ assignments });
}

const SAMPLE_FILES = ["requirements.docx", "design.pptx", "api-spec.pdf", "requirements.md"];

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_CONTEXT_TOKENS", "DATABASE_URL"]) {
    delete process.env[key];
  }
  process.env.ATLASSIAN_CLIENT_ID = "client-id";
  process.env.ATLASSIAN_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.LLM_BASE_URL = "https://llm.example.com/v1";
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_MODEL = "test-model";
  resetEnvCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed() {
  const db = await testDb();
  const [user] = await db
    .insert(users)
    .values({
      atlassianAccountId: "acc-linh-owner",
      displayName: "Linh Tran",
      accessTokenEnc: "x",
      refreshTokenEnc: "y",
      accessTokenExpiresAt: new Date(),
    })
    .returning();
  const project = await createProject(db, user.id, {
    name: "Checkout",
    cloudId: "cloud-1",
    siteUrl: "https://example.atlassian.net",
    jiraProjectKey: "CHK",
  });
  await uploadProjectFile(db, project.id, user.id, "guideline", "guidelines.md", sampleText("guidelines.md"));
  await uploadProjectFile(db, project.id, user.id, "routing", "routing.md", sampleText("routing.md"));
  return { db, user, project };
}

function serviceWith(
  db: Awaited<ReturnType<typeof testDb>>,
  llm: FakeLlm,
  fake: FakeTicketingAdapter,
  overrides: Partial<RunDeps> = {},
): RunService {
  return new RunService({
    db,
    llmFor: async () => llm,
    adapterFor: async () => fake,
    contextTokensFor: async () => 128000,
    ...overrides,
  });
}

describe("RunService", () => {
  it("full greenfield run: checks → questions → draft → edit → create", async () => {
    const { db, user, project } = await seed();
    const fake = fakeFromSample();
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY, QUESTIONS_REPLY, JSON.stringify(sampleDraftOutput), routeReply]);
    const svc = serviceWith(db, llm, fake);

    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });
    for (const name of SAMPLE_FILES) await svc.addDocument(run.id, name, sampleBytes(name));

    expect((await svc.runChecks(user.id, run.id)).ok).toBe(true);
    expect((await getRun(db, run.id)).status).toBe("checked");

    const questions = await svc.generateQuestions(run.id);
    expect(questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
    for (const q of questions) await svc.resolveQuestion(run.id, q.id, { kind: "judgment" });

    await svc.generateDraft(run.id);
    let review = await svc.getReview(run.id);
    expect(review.blockers.length).toBeGreaterThan(0);

    for (const blocker of review.blockers) {
      if (blocker.type === "pending_suggestion") {
        await svc.editDraft(run.id, { type: "suggestion", id: blocker.itemId, status: "accepted" });
      }
      if (blocker.type === "needs_routing") {
        await svc.editDraft(run.id, { type: "route", id: blocker.itemId, accountId: "acc-bao" });
      }
    }
    review = await svc.getReview(run.id);
    expect(review.blockers).toEqual([]);
    expect(review.clarificationsPreview).toContain("## Clarifications");

    const result = await svc.createTickets(user.id, run.id);
    expect(result).toEqual({ created: 12, failed: 0, skipped: 0 });
    expect(fake.issues.length).toBe(result.created);
    expect(fake.issues.find((i) => i.issueTypeName === "Epic")!.description).toContain("## Clarifications");
    expect((await getRun(db, run.id)).status).toBe("done");
  });

  it("generateDraft refuses while questions are unresolved", async () => {
    const { db, user, project } = await seed();
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY, QUESTIONS_REPLY]);
    const svc = serviceWith(db, llm, fakeFromSample());

    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });
    await svc.addDocument(run.id, "requirements.md", sampleBytes("requirements.md"));
    await svc.runChecks(user.id, run.id);
    await svc.generateQuestions(run.id);

    await expect(svc.generateDraft(run.id)).rejects.toBeInstanceOf(RunStateError);
    expect(llm.calls).toHaveLength(3);
  });

  it("runChecks reports over-budget documents without calling the LLM or Jira", async () => {
    const { db, user, project } = await seed();
    const fake = fakeFromSample();
    const getMeta = vi.spyOn(fake, "getProjectMeta");
    const llm = new FakeLlm([]);
    const svc = serviceWith(db, llm, fake, { contextTokensFor: async () => 9000 });

    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });
    await svc.addDocument(run.id, "big.txt", new TextEncoder().encode("word ".repeat(2000)));

    const result = await svc.runChecks(user.id, run.id);
    expect(result.ok).toBe(false);
    expect(result.budget).toEqual({ ok: false, estimated: expect.any(Number), limit: 1000 });
    expect(result.budget.estimated).toBeGreaterThan(1000);
    expect(llm.calls).toHaveLength(0);
    expect(getMeta).not.toHaveBeenCalled();
  });

  it("runChecks reports an existing epic key that is not an epic", async () => {
    const { db, user, project } = await seed();
    const fake = fakeFromSample();
    const [story] = await fake.createIssues([
      { clientRef: "x", projectKey: "CHK", issueTypeId: "2", summary: "A story", description: "", labels: [] },
    ]);
    if (!story.ok) throw new Error("setup failed");
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY]);
    const svc = serviceWith(db, llm, fake);

    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: story.key });
    const result = await svc.runChecks(user.id, run.id);

    expect(result.ok).toBe(false);
    expect(result.existingEpicError).toContain("is not an epic");
    expect((await getRun(db, run.id)).status).toBe("inputs");
  });

  it("routing upload deactivates the previous routing file and a guideline upload only its own filename", async () => {
    const { db, user, project } = await seed();
    const [oldRouting] = (await activeFiles(db, project.id)).filter((f) => f.kind === "routing");

    const newRouting = await uploadProjectFile(db, project.id, user.id, "routing", "routing-v2.md", "# Routing v2");
    const active = await activeFiles(db, project.id);

    expect(active.filter((f) => f.kind === "routing").map((f) => f.id)).toEqual([newRouting.id]);
    expect(active.some((f) => f.id === oldRouting.id)).toBe(false);
    expect(newRouting.version).toBe(1);

    const guidelineV2 = await uploadProjectFile(db, project.id, user.id, "guideline", "guidelines.md", "v2 rules");
    const afterGuideline = await activeFiles(db, project.id);
    expect(afterGuideline.filter((f) => f.kind === "guideline").map((f) => f.id)).toEqual([guidelineV2.id]);
    expect(afterGuideline.some((f) => f.id === newRouting.id)).toBe(true);
  });

  it("records the active file versions on the run at creation", async () => {
    const { db, user, project } = await seed();
    const svc = serviceWith(db, new FakeLlm([]), fakeFromSample());
    const files = await activeFiles(db, project.id);

    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });

    expect(run.fileVersions.map((v) => v.fileId).sort()).toEqual(files.map((f) => f.id).sort());
    expect(run.status).toBe("inputs");
  });

  it("keeps a Jira key when a later failure is recorded, and refuses to delete a created item", async () => {
    const { db, user, project } = await seed();
    const svc = serviceWith(db, new FakeLlm([]), fakeFromSample());
    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });

    const epic = mk({ id: crypto.randomUUID(), kind: "epic", title: "Checkout Revamp" });
    const story = mk({ id: crypto.randomUUID(), kind: "story", parentId: epic.id, title: "Checkout: save a card" });
    await saveDraft(db, run.id, [epic, story]);

    await setItemCreated(db, story.id, "CHK-7");
    await setItemFailed(db, story.id, "Linking failed");
    const [saved] = (await loadDraft(db, run.id)).filter((i) => i.id === story.id);
    expect(saved.jiraKey).toBe("CHK-7");
    expect(saved.createError).toBe("Linking failed");

    await db.update(runs).set({ status: "review" }).where(eq(runs.id, run.id));
    await expect(svc.editDraft(run.id, { type: "delete", id: story.id })).rejects.toBeInstanceOf(RunStateError);
    expect(await loadDraft(db, run.id)).toHaveLength(2);
  });

  it("refuses a route to a user who is not assignable to the project", async () => {
    const { db, user, project } = await seed();
    const svc = serviceWith(db, new FakeLlm([]), fakeFromSample());
    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });
    const epic = mk({ id: crypto.randomUUID(), kind: "epic", title: "Checkout Revamp" });
    const story = mk({ id: crypto.randomUUID(), kind: "story", parentId: epic.id, title: "Checkout: save a card" });
    await saveDraft(db, run.id, [epic, story]);
    await db.update(runs).set({ status: "review" }).where(eq(runs.id, run.id));

    await expect(svc.editDraft(run.id, { type: "route", id: story.id, accountId: "acc-nobody" })).rejects.toBeInstanceOf(
      TreeError,
    );
  });

  it("refuses to create tickets while items still block creation", async () => {
    const { db, user, project } = await seed();
    const fake = fakeFromSample();
    const svc = serviceWith(db, new FakeLlm([]), fake);
    const run = await svc.createRun(user.id, project.id, { epicText: EPIC, existingEpicKey: null });
    const epic = mk({ id: crypto.randomUUID(), kind: "epic", title: "Checkout Revamp" });
    const story = mk({ id: crypto.randomUUID(), kind: "story", parentId: epic.id, title: "Checkout: save a card" });
    await saveDraft(db, run.id, [epic, story]);
    const validation = validateStructure(
      { specified: true, epicType: "Epic", storyType: "Story", taskType: "Sub-task", taskLinkType: "Relates", notes: [] },
      await fake.getProjectMeta("CHK"),
    );
    if (!validation.ok) throw new Error("setup failed");
    await db.update(runs).set({ status: "review", structure: validation.resolved }).where(eq(runs.id, run.id));

    await expect(svc.createTickets(user.id, run.id)).rejects.toBeInstanceOf(CreateBlockedError);
    expect(fake.issues).toHaveLength(0);
    expect((await getRun(db, run.id)).status).toBe("review");
  });
});
