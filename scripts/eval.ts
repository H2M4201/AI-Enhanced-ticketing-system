/**
 * Evaluation harness: runs the core pipeline against the Checkout Revamp sample and reports
 * how the model did. Creates into a FakeTicketingAdapter, never into Jira, and writes no
 * database rows.
 *
 * Output is confidential-safe. The report holds only counts, booleans, step names, durations,
 * the model name and error names. Document text, prompts, model output, question text and
 * item titles never appear in it.
 *
 * CLI: npm run eval [-- --profile-json path]
 *   Reads LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (or the fields of the profile JSON).
 *   Prints a table and writes ./.data/eval-<model>-<timestamp>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ClarifyingQuestion, DraftItem, ParsedDocument, Resolution, Roster } from "@/core/domain";
import { parseDocument } from "@/core/ingest/parse";
import { createLlmClient, type LlmClient, type ProviderConfig } from "@/core/llm/client";
import { formatClarifications, generateQuestions, type PipelineInputs } from "@/core/pipeline/clarify";
import { createInTicketing } from "@/core/pipeline/create";
import { generateDraft } from "@/core/pipeline/draft";
import { parseRoster, resolveRoster, type ResolvedRoster } from "@/core/pipeline/roster";
import { routeItems } from "@/core/pipeline/route";
import { extractStructure, validateStructure, type ResolvedStructure } from "@/core/pipeline/structure";
import { activeItems } from "@/core/tree";
import { fakeFromSample } from "../tests/helpers/fake-ticketing";

export type StepName = "ingest" | "structure" | "roster" | "clarify" | "draft" | "route" | "review" | "create";

export type EvalStep = { name: StepName; ok: boolean; durationMs: number; error?: string };

export type EvalReport = {
  model: string;
  steps: EvalStep[];
  questions: number;
  plantedFlawsFound: { contradiction: boolean; ambiguity: boolean; gap: boolean };
  items: { stories: number; tasks: number; suggestions: number };
  routing: { assigned: number; needsDecision: number };
  created: number;
  failed: number;
};

const SAMPLE_DOCUMENTS = ["requirements.docx", "design.pptx", "api-spec.pdf"];
const EPIC_FILE = "epic.md";
const GUIDELINES_FILE = "guidelines.md";
const ROUTING_FILE = "routing.md";
const DEFAULT_CONTEXT_TOKENS = 128000;
const QA_TEAM = "QA";
export const FIXED_FAILURE_MESSAGE = "step failed; details withheld so that no document text is recorded";
const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g;

/** Raised when a step's output does not allow the run to continue. */
class EvalCheckError extends Error {
  override name = "EvalCheckError";
}

/** Thrown after a failed step has been recorded. Stops the run without losing the partial report. */
class StepAborted extends Error {}

function errorNameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return name.replace(UNSAFE_CHARS, "_").slice(0, 60);
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

/** Runs one named step. A failure is recorded as its error name and a fixed message, then the run stops. */
async function runStep<T>(steps: EvalStep[], name: StepName, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const value = await work();
    steps.push({ name, ok: true, durationMs: elapsedSince(started) });
    return value;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      durationMs: elapsedSince(started),
      error: `${errorNameOf(error)}: ${FIXED_FAILURE_MESSAGE}`,
    });
    throw new StepAborted(name);
  }
}

const SECTION_2_1_OR_3_2 = /^requirements\.[^ ]+ §(2\.1|3\.2)$/;
const SECTION_1 = /^requirements\.[^ ]+ §1$/;

/** Checks the questions for the three flaws planted in samples/checkout-revamp. */
export function plantedFlaws(questions: ClarifyingQuestion[]): EvalReport["plantedFlawsFound"] {
  const cites = (q: ClarifyingQuestion, pattern: RegExp): boolean => q.sourceRefs.some((ref) => pattern.test(ref));
  return {
    contradiction: questions.some((q) => q.category === "contradiction" && cites(q, SECTION_2_1_OR_3_2)),
    ambiguity: questions.some((q) => q.category === "ambiguity" && cites(q, SECTION_1)),
    gap: questions.some((q) => q.category === "missing" && /timeout|fail/i.test(q.text)),
  };
}

/** Accepts every pending AI suggestion, then gives items the model could not route to the QA default person. */
function reviewDraft(items: DraftItem[], roster: ResolvedRoster): DraftItem[] {
  const qaDefault = roster.teamDefaults[QA_TEAM];
  if (!qaDefault) throw new EvalCheckError("the QA team has no resolved default person");

  return items.map((item) => {
    const accepted: DraftItem =
      item.origin === "ai_suggestion" && item.suggestionStatus === "pending"
        ? { ...item, suggestionStatus: "accepted" }
        : item;
    if (accepted.routing?.status !== "needs_decision") return accepted;
    return {
      ...accepted,
      routing: {
        status: "assigned",
        accountId: qaDefault.accountId,
        displayName: qaDefault.displayName,
        teamName: QA_TEAM,
        reason: "Eval: no routing rule applied, so the QA default person was used",
        ruleId: null,
        ruleQuote: null,
        ruleLine: null,
        overridden: true,
      },
    };
  });
}

/**
 * Runs the full pipeline on a sample folder with the given model. Items are created in a
 * FakeTicketingAdapter built from samples/fake-jira-project.json. A failed step ends the run,
 * and the report then holds the steps that ran, with zeroed counts.
 */
export async function evaluate(llm: LlmClient, sampleDir: string): Promise<EvalReport> {
  const dir = resolve(sampleDir);
  const read = (file: string): string => readFileSync(join(dir, file), "utf8");
  const steps: EvalStep[] = [];
  const report: EvalReport = {
    model: llm.model,
    steps,
    questions: 0,
    plantedFlawsFound: { contradiction: false, ambiguity: false, gap: false },
    items: { stories: 0, tasks: 0, suggestions: 0 },
    routing: { assigned: 0, needsDecision: 0 },
    created: 0,
    failed: 0,
  };

  try {
    const documents: ParsedDocument[] = await runStep(steps, "ingest", () =>
      Promise.all(
        SAMPLE_DOCUMENTS.map((file) => parseDocument(file, new Uint8Array(readFileSync(join(dir, file))))),
      ),
    );
    const guidelines = [{ filename: GUIDELINES_FILE, content: read(GUIDELINES_FILE) }];
    const inputs: PipelineInputs = { epicText: read(EPIC_FILE), documents, guidelines };

    const adapter = fakeFromSample();
    const meta = adapter.projectMeta;

    const structure: ResolvedStructure = await runStep(steps, "structure", async () => {
      const validation = validateStructure(await extractStructure(llm, guidelines), meta);
      if (!validation.ok) throw new EvalCheckError("the guidelines' structure does not match the project");
      return validation.resolved;
    });

    const roster: ResolvedRoster = await runStep(steps, "roster", async () => {
      const parsed: Roster = await parseRoster(llm, { filename: ROUTING_FILE, content: read(ROUTING_FILE) });
      return resolveRoster(parsed, await adapter.listAssignableUsers(meta.key));
    });

    const questions = await runStep(steps, "clarify", () => generateQuestions(llm, inputs));
    report.questions = questions.length;
    report.plantedFlawsFound = plantedFlaws(questions);
    // Every question is resolved as "use your judgment", so the draft makes assumptions and tags them.
    const resolutions: Record<string, Resolution> = Object.fromEntries(
      questions.map((q) => [q.id, { kind: "judgment" as const }]),
    );

    const drafted = await runStep(steps, "draft", () =>
      generateDraft(llm, { inputs, questions, resolutions, structure }),
    );

    const routed = await runStep(steps, "route", () => routeItems(llm, { items: drafted, roster }));
    // Routing coverage is counted before the QA fallback below, so it shows what the model decided.
    const routable = activeItems(routed).filter((item) => item.kind !== "epic");
    report.routing = {
      assigned: routable.filter((item) => item.routing?.status === "assigned").length,
      needsDecision: routable.filter((item) => item.routing?.status === "needs_decision").length,
    };

    const reviewed = await runStep(steps, "review", async () => reviewDraft(routed, roster));
    const active = activeItems(reviewed);
    report.items = {
      stories: active.filter((item) => item.kind === "story").length,
      tasks: active.filter((item) => item.kind === "task").length,
      suggestions: active.filter((item) => item.origin === "ai_suggestion").length,
    };

    await runStep(steps, "create", async () => {
      const summary = await createInTicketing({
        adapter,
        meta,
        projectKey: meta.key,
        runId: randomUUID(),
        items: reviewed,
        structure,
        existingEpicKey: null,
        clarificationsText: formatClarifications(questions, resolutions),
        clarificationsWritten: false,
        acceptedByName: "Evaluation",
        requiredFields: {
          epic: structure.epic.requiredFields,
          story: structure.story.requiredFields,
          task: structure.task.requiredFields,
        },
        onItemCreated: async () => {},
        onItemFailed: async () => {},
        onClarificationsWritten: async () => {},
      });
      report.created = summary.created;
      report.failed = summary.failed;
      // Any failed item makes the create step not ok, though the counts above are still reported.
      if (summary.failed > 0) throw new EvalCheckError("some items were not created");
    });
  } catch (error) {
    if (!(error instanceof StepAborted)) throw error;
  }
  return report;
}

/** The JSON file name for one run. The model name is reduced to letters, digits, dots, underscores and hyphens. */
export function reportFileName(model: string, at: Date): string {
  const safeModel = model.replace(UNSAFE_CHARS, "_");
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `eval-${safeModel}-${stamp}.json`;
}

type ProfileOverrides = Partial<
  Pick<ProviderConfig, "baseUrl" | "apiKey" | "model" | "supportsJsonMode" | "contextTokens">
>;

function readProfile(path: string | undefined): ProfileOverrides {
  if (path === undefined) return {};
  // A bad profile file is not echoed, because a parse error can quote the apiKey it contains.
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The profile JSON must be an object");
  }
  return parsed as ProfileOverrides;
}

/** A configuration problem whose message is fixed text, so it is safe to print. */
class EvalConfigError extends Error {
  override name = "EvalConfigError";
}

/** The profile's context window, else LLM_CONTEXT_TOKENS, else the default. */
function contextTokensFrom(profile: ProfileOverrides, env: NodeJS.ProcessEnv): number {
  if (profile.contextTokens !== undefined) return profile.contextTokens;
  if (env.LLM_CONTEXT_TOKENS === undefined || env.LLM_CONTEXT_TOKENS === "") return DEFAULT_CONTEXT_TOKENS;
  const parsed = Number(env.LLM_CONTEXT_TOKENS);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EvalConfigError("LLM_CONTEXT_TOKENS must be a positive whole number");
  }
  return parsed;
}

function providerConfigFrom(profile: ProfileOverrides, env: NodeJS.ProcessEnv): ProviderConfig {
  const baseUrl = profile.baseUrl ?? env.LLM_BASE_URL;
  const apiKey = profile.apiKey ?? env.LLM_API_KEY;
  const model = profile.model ?? env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new EvalConfigError("Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the environment, or pass --profile-json");
  }
  return {
    baseUrl,
    apiKey,
    model,
    supportsJsonMode: profile.supportsJsonMode ?? false,
    contextTokens: contextTokensFrom(profile, env),
  };
}

function printReport(report: EvalReport): void {
  console.log(`Model: ${report.model}`);
  console.table(
    report.steps.map((s) => ({ step: s.name, ok: s.ok, durationMs: s.durationMs, error: s.error ?? "" })),
  );
  console.log(`Questions: ${report.questions}`);
  const flaws = report.plantedFlawsFound;
  console.log(`Planted flaws found: contradiction=${flaws.contradiction} ambiguity=${flaws.ambiguity} gap=${flaws.gap}`);
  console.log(
    `Items: stories=${report.items.stories} tasks=${report.items.tasks} suggestions=${report.items.suggestions}`,
  );
  console.log(`Routing: assigned=${report.routing.assigned} needsDecision=${report.routing.needsDecision}`);
  console.log(`Created: ${report.created} Failed: ${report.failed}`);
}

async function main(argv: string[]): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const profileIndex = argv.indexOf("--profile-json");
  if (profileIndex >= 0 && argv[profileIndex + 1] === undefined) {
    throw new EvalConfigError("--profile-json needs a file path");
  }
  const profilePath = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  const llm = createLlmClient(providerConfigFrom(readProfile(profilePath), process.env));

  const report = await evaluate(llm, join(process.cwd(), "samples", "checkout-revamp"));
  printReport(report);

  const dataDir = join(process.cwd(), ".data");
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, reportFileName(report.model, new Date()));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${file}`);
}

// Runs only when this file is the entry point, so importing it (as the test does) has no side effects.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Only fixed configuration messages are printed. Other errors show their name, so no
    // configuration values or document text leak out.
    const detail = error instanceof EvalConfigError ? error.message : errorNameOf(error);
    console.error(`Evaluation failed: ${detail}`);
    process.exitCode = 1;
  });
}
