import { computeBlockers, type Blocker } from "@/core/blockers";
import type { ClarifyingQuestion, DraftItem, ItemKind, ParsedDocument, Resolution } from "@/core/domain";
import { parseDocument } from "@/core/ingest/parse";
import { checkContextBudget } from "@/core/llm/budget";
import type { LlmClient } from "@/core/llm/client";
import { generateQuestions as generateClarifyingQuestions } from "@/core/pipeline/clarify";
import { CreateBlockedError, createInTicketing, type CreateSummary } from "@/core/pipeline/create";
import { generateDraft as generateDraftItems } from "@/core/pipeline/draft";
import { parseRoster, resolveRoster, type UnresolvedName } from "@/core/pipeline/roster";
import { routeItems } from "@/core/pipeline/route";
import { extractStructure, validateStructure } from "@/core/pipeline/structure";
import { activeItems } from "@/core/tree";
import type { AssignableUser, TicketingAdapter } from "@/core/ticketing/adapter";
import { safeLog } from "@/lib/log";
import type { Db } from "@/server/db/client";
import { NotFoundError, RunStateError } from "@/server/errors";
import { describeProvider, type ProviderDescription } from "@/server/providers";
import { getProject, activeFiles, type Project } from "@/server/projects";
import {
  budgetParts,
  clarificationsTextOf,
  EMPTY_ROSTER,
  loadDocuments,
  loadRunFiles,
  pipelineInputs,
  requiredFieldsOf,
  requireStructure,
  resolutionsOf,
  rosterOf,
  structureOf,
} from "@/server/runs/context";
import { applyDraftOp, type DraftOp } from "@/server/runs/ops";
import {
  deleteDocument,
  getRun,
  insertDocument,
  insertRun,
  listQuestions,
  loadDraft,
  replaceQuestions,
  type Run,
  saveDraft,
  saveResolution,
  setItemCreated,
  setItemFailed,
  touch,
  updateRun,
  userDisplayName,
} from "@/server/runs/repo";

export type RunDeps = {
  db: Db;
  llmFor: (project: Project) => Promise<LlmClient>;
  adapterFor: (userId: string, project: Project) => Promise<TicketingAdapter>;
  /** The context window of the project's provider, used for the input budget check. */
  contextTokensFor: (project: Project) => Promise<number>;
};

export type RunDocumentView = {
  id: string;
  filename: string;
  kind: ParsedDocument["kind"];
  charCount: number;
};

export type ChecksResult = {
  ok: boolean;
  budget: { estimated: number; limit: number; ok: boolean };
  structure: { errors: string[]; warnings: string[]; notes: string[] };
  roster: { teams: number; people: number; rules: number; unresolved: UnresolvedName[] };
  existingEpicError: string | null;
};

export type ReviewView = {
  items: DraftItem[];
  blockers: Blocker[];
  requiredFields: Record<ItemKind, { key: string; name: string }[]>;
  provider: ProviderDescription;
  existingEpic: { key: string; summary: string } | null;
  clarificationsPreview: string;
  assignableUsers: AssignableUser[];
};

function assertStatus(run: Run, allowed: Run["status"][], message: string): void {
  if (!allowed.includes(run.status)) throw new RunStateError(message);
}

/** Returns a problem with the existing epic key, or null when it names an epic in Jira. */
async function existingEpicProblem(adapter: TicketingAdapter, key: string | null): Promise<string | null> {
  if (key === null) return null;
  const issue = await adapter.getIssue(key);
  if (issue === null) return `${key} was not found in Jira`;
  if (issue.level !== "epic") return `${key} is not an epic`;
  return null;
}

/**
 * Orchestrates a run through its steps: inputs, checks, questions, draft, review and
 * ticket creation. Every method records activity on the run. Logs carry ids and counts only.
 */
export class RunService {
  constructor(private readonly deps: RunDeps) {}

  async createRun(userId: string, projectId: string, input: { epicText: string; existingEpicKey: string | null }): Promise<Run> {
    const { db } = this.deps;
    const project = await getProject(db, projectId);
    const files = await activeFiles(db, project.id);
    const run = await insertRun(db, {
      projectId: project.id,
      createdBy: userId,
      epicText: input.epicText,
      existingEpicKey: input.existingEpicKey?.trim() || null,
      fileVersions: files.map((file) => ({ fileId: file.id, sha256: file.sha256 })),
    });
    safeLog("run.created", { runId: run.id, projectId: project.id, userId, count: files.length });
    return run;
  }

  /** Documents can change before the draft is generated. A change to a checked run sends it back to inputs. */
  private async openInputs(runId: string): Promise<void> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["inputs", "checked"], "Documents can only change before the draft is generated");
    await touch(db, runId);
    if (run.status === "checked") await updateRun(db, runId, { status: "inputs" });
  }

  async addDocument(runId: string, filename: string, bytes: Uint8Array): Promise<RunDocumentView> {
    const parsed = await parseDocument(filename, bytes);
    await this.openInputs(runId);
    const charCount = parsed.sections.reduce((total, section) => total + section.text.length, 0);
    const row = await insertDocument(this.deps.db, {
      runId,
      filename: parsed.filename,
      kind: parsed.kind,
      sections: parsed.sections,
      charCount,
    });
    return { id: row.id, filename: row.filename, kind: parsed.kind, charCount };
  }

  async removeDocument(runId: string, docId: string): Promise<void> {
    await this.openInputs(runId);
    await deleteDocument(this.deps.db, runId, docId);
  }

  /**
   * Checks the inputs before any model or Jira work for the draft: the context budget first,
   * then the guideline structure, the routing roster, and the existing epic. Stores the results.
   */
  async runChecks(userId: string, runId: string): Promise<ChecksResult> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["inputs", "checked"], "Checks can only run before clarifying questions are generated");
    await touch(db, runId);
    const project = await getProject(db, run.projectId);

    const documents = await loadDocuments(db, runId);
    const files = await loadRunFiles(db, run);
    const budget = checkContextBudget(
      budgetParts(run.epicText, documents, files.guidelines),
      await this.deps.contextTokensFor(project),
    );
    if (!budget.ok) {
      await updateRun(db, runId, { status: "inputs" });
      safeLog("run.checked", { runId, status: "over_budget" });
      return {
        ok: false,
        budget,
        structure: { errors: [], warnings: [], notes: [] },
        roster: { teams: 0, people: 0, rules: 0, unresolved: [] },
        existingEpicError: null,
      };
    }

    const llm = await this.deps.llmFor(project);
    const adapter = await this.deps.adapterFor(userId, project);
    const meta = await adapter.getProjectMeta(project.jiraProjectKey);
    const plan = await extractStructure(llm, files.guidelines);
    const validation = validateStructure(plan, meta);
    const roster = files.routing ? await parseRoster(llm, files.routing) : EMPTY_ROSTER;
    const users = await adapter.listAssignableUsers(project.jiraProjectKey);
    const resolved = resolveRoster(roster, users);
    const existingEpicError = await existingEpicProblem(adapter, run.existingEpicKey);

    const ok = validation.ok && existingEpicError === null;
    await updateRun(db, runId, {
      status: ok ? "checked" : "inputs",
      structure: validation.ok ? validation.resolved : null,
      roster,
      assignableUsers: users,
    });
    safeLog("run.checked", { runId, status: ok ? "ok" : "failed", count: users.length });

    return {
      ok,
      budget,
      structure: validation.ok
        ? { errors: [], warnings: validation.warnings, notes: plan.notes }
        : { errors: validation.errors, warnings: [], notes: plan.notes },
      roster: {
        teams: roster.teams.length,
        people: roster.people.length,
        rules: roster.rules.length,
        unresolved: resolved.unresolved,
      },
      existingEpicError,
    };
  }

  async generateQuestions(runId: string): Promise<ClarifyingQuestion[]> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["checked", "questions"], "Run the checks before generating questions");
    await touch(db, runId);
    const project = await getProject(db, run.projectId);
    const documents = await loadDocuments(db, runId);
    const inputs = pipelineInputs(run, documents, await loadRunFiles(db, run));

    const questions = await generateClarifyingQuestions(await this.deps.llmFor(project), inputs);
    await replaceQuestions(db, runId, questions);
    await updateRun(db, runId, { status: "questions" });
    safeLog("run.questions", { runId, count: questions.length });
    return questions;
  }

  async resolveQuestion(runId: string, questionId: string, resolution: Resolution): Promise<void> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["questions"], "Questions can only be answered before the draft is generated");
    await touch(db, runId);
    const stored = (await listQuestions(db, runId)).find((entry) => entry.question.id === questionId);
    if (!stored) throw new NotFoundError("Question");
    await saveResolution(db, stored.rowId, resolution);
  }

  /** Builds the draft from the inputs and answers, then routes it. Refused while any question is unanswered. */
  async generateDraft(runId: string): Promise<DraftItem[]> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["questions", "review"], "The draft can be generated after the questions step");
    await touch(db, runId);

    const stored = await listQuestions(db, runId);
    const unresolved = stored.filter((entry) => entry.resolution === null).length;
    if (unresolved > 0) throw new RunStateError(`${unresolved} clarifying question(s) still need an answer`);
    if ((await loadDraft(db, runId)).some((item) => item.jiraKey !== null)) {
      throw new RunStateError("Tickets already exist for this draft, so it cannot be regenerated");
    }

    const structure = requireStructure(run);
    const project = await getProject(db, run.projectId);
    const llm = await this.deps.llmFor(project);
    const inputs = pipelineInputs(run, await loadDocuments(db, runId), await loadRunFiles(db, run));
    const drafted = await generateDraftItems(llm, {
      inputs,
      questions: stored.map((entry) => entry.question),
      resolutions: resolutionsOf(stored),
      structure,
    });
    const routed = await routeItems(llm, {
      items: drafted,
      roster: resolveRoster(rosterOf(run), run.assignableUsers ?? []),
    });

    await saveDraft(db, runId, routed);
    await updateRun(db, runId, { status: "review" });
    safeLog("run.draft", { runId, count: routed.length });
    return routed;
  }

  /** Applies one edit to the reviewed draft. Editing is allowed only while the draft is under review. */
  async editDraft(runId: string, op: DraftOp): Promise<DraftItem[]> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["review"], "The draft can only be edited while it is under review");
    await touch(db, runId);
    const next = applyDraftOp(await loadDraft(db, runId), op, run.assignableUsers ?? []);
    await saveDraft(db, runId, next);
    return next;
  }

  async getReview(runId: string): Promise<ReviewView> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    await touch(db, runId);
    const project = await getProject(db, run.projectId);
    const items = await loadDraft(db, runId);
    const requiredFields = requiredFieldsOf(structureOf(run));
    const stored = await listQuestions(db, runId);

    return {
      items,
      blockers: computeBlockers(items, requiredFields),
      requiredFields,
      provider: await describeProvider(db, project),
      existingEpic: run.existingEpicKey === null ? null : await this.existingEpic(run.createdBy, project, run.existingEpicKey),
      clarificationsPreview: clarificationsTextOf(stored),
      assignableUsers: run.assignableUsers ?? [],
    };
  }

  /** The epic's summary is read from Jira with the run creator's access. */
  private async existingEpic(creatorId: string, project: Project, key: string): Promise<{ key: string; summary: string }> {
    const adapter = await this.deps.adapterFor(creatorId, project);
    const issue = await adapter.getIssue(key);
    return { key, summary: issue?.summary ?? "" };
  }

  /**
   * Creates the reviewed draft in Jira. The run is "creating" while this runs and "done" once
   * every active item has a key. A partial failure leaves it "creating" so Retry can finish it.
   */
  async createTickets(userId: string, runId: string): Promise<CreateSummary> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["review", "creating"], "Tickets can only be created from a reviewed draft");
    await touch(db, runId);
    const project = await getProject(db, run.projectId);
    const structure = requireStructure(run);
    const requiredFields = requiredFieldsOf(structure);

    const items = await loadDraft(db, runId);
    const blockers = computeBlockers(items, requiredFields);
    if (blockers.length > 0) throw new CreateBlockedError(blockers);

    const adapter = await this.deps.adapterFor(userId, project);
    const meta = await adapter.getProjectMeta(project.jiraProjectKey);
    const acceptedByName = await userDisplayName(db, userId);
    const stored = await listQuestions(db, runId);

    await updateRun(db, runId, { status: "creating" });
    const summary = await createInTicketing({
      adapter,
      meta,
      projectKey: project.jiraProjectKey,
      runId,
      items,
      structure,
      existingEpicKey: run.existingEpicKey,
      clarificationsText: clarificationsTextOf(stored),
      clarificationsWritten: run.clarificationsWritten,
      acceptedByName,
      requiredFields,
      onItemCreated: (itemId, key) => setItemCreated(db, itemId, key),
      onItemFailed: (itemId, error) => setItemFailed(db, itemId, error),
      onClarificationsWritten: () => updateRun(db, runId, { clarificationsWritten: true }),
    });

    const complete = activeItems(await loadDraft(db, runId)).every((item) => item.jiraKey !== null);
    if (complete) await updateRun(db, runId, { status: "done", completedAt: new Date() });
    safeLog("run.tickets", { runId, count: summary.created, status: complete ? "done" : "creating" });
    return summary;
  }
}
