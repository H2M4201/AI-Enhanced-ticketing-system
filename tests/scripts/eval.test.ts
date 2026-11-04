import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClarifyingQuestion } from "@/core/domain";
import { evaluate, FIXED_FAILURE_MESSAGE, plantedFlaws, reportFileName } from "../../scripts/eval";
import { FakeLlm } from "../helpers/fake-llm";
import { sampleDraftOutput } from "../helpers/sample-draft";

const SAMPLE_DIR = fileURLToPath(new URL("../../samples/checkout-revamp", import.meta.url));

/** Phrases from samples/checkout-revamp/requirements.md that must never reach the report. */
const DOCUMENT_PHRASES = [
  "Northwind Goods",
  "Saved cards are stored by the payment provider",
  "Multi-currency pricing is not part of this release",
];

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
    { condition: "payments or cards", target: { type: "team", name: "Payments" }, line: 22, quote: "Anything touching payments or cards" },
    { condition: "QA sub-tasks", target: { type: "team", name: "QA" }, line: 23, quote: "QA sub-tasks" },
    { condition: "database migrations", target: { type: "person", name: "Bao Le" }, line: 24, quote: "Database migrations" },
    { condition: "cart, checkout page or order summary", target: { type: "team", name: "Frontend" }, line: 25, quote: "Anything touching the cart, checkout page or order summary UI" },
    { condition: "API or order service", target: { type: "team", name: "Backend" }, line: 26, quote: "API endpoints and order service changes" },
    { condition: "confirmation email templates", target: { type: "team", name: "Backend" }, line: 27, quote: "Order confirmation email templates" },
    { condition: "saved card removal", target: { type: "team", name: "Payments" }, line: 28, quote: "Saved card removal in the account page" },
  ],
});

const CLARIFY_REPLY = JSON.stringify({
  questions: [
    {
      category: "contradiction",
      text: "Section 2.1 lets guests save a card, but section 3.2 says only logged-in users can. Which rule applies?",
      sourceRefs: ["requirements.docx §2.1", "requirements.docx §3.2"],
      rank: 1,
    },
    {
      category: "ambiguity",
      text: "The goals say the checkout must be fast. What counts as fast?",
      sourceRefs: ["requirements.docx §1"],
      rank: 2,
    },
    {
      category: "missing",
      text: "What should the shopper see when the payment provider times out or fails?",
      sourceRefs: ["requirements.docx §5"],
      rank: 3,
    },
    {
      category: "missing",
      text: "Which shipping methods are shown first on the page?",
      sourceRefs: ["requirements.docx §7"],
      rank: 4,
    },
  ],
});

/** The draft reply is the shared sample, with its requirements refs pointed at the .docx the pipeline reads. */
const DRAFT_REPLY = JSON.stringify(sampleDraftOutput).replaceAll("requirements.md", "requirements.docx");

/** Route picks by item title. Null means the model found no rule, so the item needs a decision. */
const ROUTE_BY_TITLE: Record<string, string | null> = {
  "Checkout: one-page guest checkout": "R4",
  "Checkout: render the one-page guest form": "R4",
  "QA: test one-page guest checkout": "R2",
  "Checkout: save a card": "R1",
  "Checkout: hide the save-card checkbox for guests": "R4",
  "QA: test save a card": "R2",
  "Checkout: order confirmation email": "R6",
  "Checkout: send the confirmation email when the order is placed": "R6",
  "QA: test order confirmation email": "R2",
  "Payment timeout handling": null,
  "Checkout: show a timeout message on the payment step": null,
};

/** Reads the item ids and titles from the route prompt, so the reply names the items that were actually sent. */
function routeReply(messages: { content: string }[]): string {
  const prompt = messages.map((m) => m.content).join("\n");
  const assignments = [...prompt.matchAll(/<item id="([^"]*)" kind="[^"]*">\nTitle: ([^\n]*)/g)].map(([, itemId, title]) => ({
    itemId,
    ruleId: ROUTE_BY_TITLE[title] ?? null,
    reason: ROUTE_BY_TITLE[title] ? "Matches the routing rule for this work." : "No routing rule clearly applies.",
  }));
  return JSON.stringify({ assignments });
}

describe("evaluate", () => {
  it("runs the full pipeline on the sample set and finds every planted flaw", async () => {
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY, CLARIFY_REPLY, DRAFT_REPLY, routeReply]);

    const report = await evaluate(llm, SAMPLE_DIR);

    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(report.plantedFlawsFound).toEqual({ contradiction: true, ambiguity: true, gap: true });
    expect(report.created).toBe(report.items.stories + report.items.tasks + 1);
    expect(report.failed).toBe(0);
    expect(report.routing.assigned + report.routing.needsDecision).toBe(report.items.stories + report.items.tasks);
  });

  it("keeps document text, prompts and model output out of the report", async () => {
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY, CLARIFY_REPLY, DRAFT_REPLY, routeReply]);

    const json = JSON.stringify(await evaluate(llm, SAMPLE_DIR), null, 2);

    for (const phrase of DOCUMENT_PHRASES) expect(json).not.toContain(phrase);
  });
});

function question(category: ClarifyingQuestion["category"], text: string, sourceRefs: string[]): ClarifyingQuestion {
  return { id: "Q1", category, text, sourceRefs, rank: 1 };
}

const FLAW_QUESTIONS: ClarifyingQuestion[] = [
  question("contradiction", "Guest save or account only?", ["requirements.docx §2.1", "requirements.docx §3.2"]),
  question("ambiguity", "What counts as fast?", ["requirements.docx §1"]),
  question("missing", "What happens on payment timeout?", ["requirements.docx §5"]),
];

describe("plantedFlaws", () => {
  it("finds all three flaws when the questions cite them correctly", () => {
    expect(plantedFlaws(FLAW_QUESTIONS)).toEqual({ contradiction: true, ambiguity: true, gap: true });
  });

  it.each([
    ["the contradiction does not cite §2.1 or §3.2", [question("contradiction", "Guest save?", ["requirements.docx §2"])], "contradiction"],
    ["the §2.1 question is not a contradiction", [question("ambiguity", "Guest save?", ["requirements.docx §2.1"])], "contradiction"],
    ["the ambiguity does not cite §1", [question("ambiguity", "What counts as fast?", ["requirements.docx §2"])], "ambiguity"],
    ["the §1 question is not an ambiguity", [question("missing", "What counts as fast?", ["requirements.docx §1"])], "ambiguity"],
    ["the gap question has no timeout or fail text", [question("missing", "Which shipping methods?", ["requirements.docx §5"])], "gap"],
    ["the timeout question is not a missing-information question", [question("ambiguity", "Timeout handling?", ["requirements.docx §5"])], "gap"],
  ])("reports the flaw as not found when %s", (_case, questions, flaw) => {
    const found = plantedFlaws(questions);
    expect(found[flaw as keyof typeof found]).toBe(false);
  });
});

describe("evaluate error path", () => {
  const SECRET_SENTENCE = "Canary sentence: the model said the private wording here.";
  /** Everything a leak could carry: the canary, the sample phrases and the distinctive reply text. */
  const LEAK_TEXT = [SECRET_SENTENCE, ...DOCUMENT_PHRASES, "What counts as fast?", "Payment timeout handling"];

  it("records a thrown draft error by name and fixed message, without its text", async () => {
    const llm = new FakeLlm([
      STRUCTURE_REPLY,
      ROSTER_REPLY,
      CLARIFY_REPLY,
      () => {
        throw new Error(LEAK_TEXT.join(" "));
      },
    ]);

    const report = await evaluate(llm, SAMPLE_DIR);
    const json = JSON.stringify(report, null, 2);

    const draft = report.steps.find((step) => step.name === "draft");
    expect(draft).toEqual({ name: "draft", ok: false, durationMs: expect.any(Number), error: `Error: ${FIXED_FAILURE_MESSAGE}` });
    expect(report.steps.at(-1)?.name).toBe("draft");
    for (const text of LEAK_TEXT) expect(json).not.toContain(text);
  });

  it("records unusable model output as LlmOutputError without its text", async () => {
    const unusable = () => `Not JSON at all. ${LEAK_TEXT.join(" ")}`;
    const llm = new FakeLlm([STRUCTURE_REPLY, ROSTER_REPLY, CLARIFY_REPLY, unusable, unusable, unusable]);

    const report = await evaluate(llm, SAMPLE_DIR);
    const json = JSON.stringify(report, null, 2);

    const draft = report.steps.find((step) => step.name === "draft");
    expect(draft).toEqual({ name: "draft", ok: false, durationMs: expect.any(Number), error: `LlmOutputError: ${FIXED_FAILURE_MESSAGE}` });
    for (const text of LEAK_TEXT) expect(json).not.toContain(text);
  });
});

describe("reportFileName", () => {
  it("keeps only letters, digits, dots, underscores and hyphens from the model name", () => {
    const name = reportFileName("gpt-4o/mini:latest", new Date("2026-11-05T01:02:03.456Z"));
    expect(name).toBe("eval-gpt-4o_mini_latest-2026-11-05T01-02-03-456Z.json");
  });
});
