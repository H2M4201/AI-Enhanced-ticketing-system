import { computeBlockers, type Blocker } from "@/core/blockers";
import type {
  ClarifyingQuestion,
  DraftItem,
  ItemKind,
  ParsedDocument,
  Resolution,
  Roster,
  RosterRule,
} from "@/core/domain";
import { parseDocument } from "@/core/ingest/parse";
import { checkContextBudget } from "@/core/llm/budget";
import type { LlmClient } from "@/core/llm/client";
import { generateQuestions as generateClarifyingQuestions } from "@/core/pipeline/clarify";
import { CreateBlockedError, createInTicketing, runLabel, type CreateSummary } from "@/core/pipeline/create";
import { generateDraft as generateDraftItems } from "@/core/pipeline/draft";
import { parseRoster, resolveRoster, type UnresolvedName } from "@/core/pipeline/roster";
import { routeItems } from "@/core/pipeline/route";
import { extractStructure, validateStructure } from "@/core/pipeline/structure";
import { activeItems } from "@/core/tree";
import type { AssignableUser, TicketingAdapter } from "@/core/ticketing/adapter";
import { safeLog } from "@/lib/log";
import type { Db } from "@/server/db/client";
import { NoProviderError, NotFoundError, ReauthRequiredError, RunStateError } from "@/server/errors";
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
  claimCreation,
  creationLockMinutesLeft,
  deleteDocument,
  getRun,
  getRunDocument,
  insertDocument,
  insertRun,
  isCreationLocked,
  isWithinRetryGap,
  listDocuments,
  listProjectRuns,
  listQuestions,
  loadDraft,
  releaseCreation,
  replaceQuestions,
  RETRY_GAP_MS,
  type Run,
  saveDraft,
  saveDraftVersioned,
  saveItemEdit,
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
  /** How long a retry waits after the last creation attempt ended. Defaults to RETRY_GAP_MS; tests set 0. */
  retryGapMs?: number;
};

/** One row of a project's run list. */
export type RunListItem = {
  id: string;
  status: Run["status"];
  createdAt: Date;
  createdByName: string;
  /** The first line of the epic text, capped at EPIC_LINE_MAX. Empty once retention has purged the text. */
  epicFirstLine: string;
};

const EPIC_LINE_MAX = 120;

function firstLineOf(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, EPIC_LINE_MAX);
}

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
  roster: {
    teams: Roster["teams"];
    people: Roster["people"];
    rules: RosterRule[];
    /** Each team's resolved default user, or null when the default person is not an assignable user. */
    teamDefaults: Record<string, AssignableUser | null>;
    unresolved: UnresolvedName[];
  };
  existingEpicError: string | null;
};

export type ReviewView = {
  /** The run's status: review, creating (a partial create failure) or done. */
  status: Run["status"];
  /** The version to pass to editDraft. */
  draftVersion: number;
  items: DraftItem[];
  blockers: Blocker[];
  requiredFields: Record<ItemKind, { key: string; name: string }[]>;
  /** Null when no provider is configured for the project. */
  provider: ProviderDescription | null;
  /** The summary is null when Jira could not be read; the UI then shows the key alone. */
  existingEpic: { key: string; summary: string | null } | null;
  clarificationsPreview: string;
  assignableUsers: AssignableUser[];
};

/** What an edit changes: the review without the provider and the existing-epic lookups. */
export type DraftState = Pick<ReviewView, "status" | "draftVersion" | "items" | "blockers" | "assignableUsers">;

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
  private async documentRun(runId: string): Promise<Run> {
    const run = await getRun(this.deps.db, runId);
    assertStatus(run, ["inputs", "checked"], "Documents can only change before the draft is generated");
    return run;
  }

  private async openInputs(runId: string): Promise<void> {
    const { db } = this.deps;
    const run = await this.documentRun(runId);
    await touch(db, runId);
    if (run.status === "checked") await updateRun(db, runId, { status: "inputs" });
  }

  async addDocument(runId: string, filename: string, bytes: Uint8Array): Promise<RunDocumentView> {
    // The status is checked before parsing, so a refused change never reports a parse error.
    await this.documentRun(runId);
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
        roster: { teams: [], people: [], rules: [], teamDefaults: {}, unresolved: [] },
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
        teams: roster.teams,
        people: roster.people,
        rules: roster.rules,
        teamDefaults: resolved.teamDefaults,
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

  /**
   * Applies one edit to the draft. Under review, any op is allowed and the whole draft is saved.
   * While tickets are being created, only route and update are allowed, on items without a Jira key,
   * and only when no creation holds the lock. expectedVersion must match the draft the caller saw.
   */
  async editDraft(runId: string, op: DraftOp, expectedVersion: number): Promise<DraftItem[]> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    assertStatus(run, ["review", "creating"], "The draft can only be edited while it is under review");
    await touch(db, runId);
    const users = run.assignableUsers ?? [];

    if (run.status === "review") {
      const next = applyDraftOp(await loadDraft(db, runId), op, users);
      await saveDraftVersioned(db, runId, expectedVersion, next);
      return next;
    }

    // Creating: the gate comes before applying the op, so refusals are reported as state errors.
    if (op.type !== "route" && op.type !== "update") {
      throw new RunStateError("While tickets are being created, only assignee and field edits are allowed");
    }
    if (isCreationLocked(run)) throw new RunStateError("Ticket creation is in progress");
    const next = applyDraftOp(await loadDraft(db, runId), op, users);
    const changed = next.find((item) => item.id === op.id);
    if (!changed) throw new NotFoundError("Draft item");
    await saveItemEdit(db, runId, expectedVersion, changed);
    return next;
  }

  /** The run page's stored state: status, epic text, documents, the saved check results and the questions. */
  async getRunDetail(runId: string) {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    const documents = await listDocuments(db, runId);
    const questions = await listQuestions(db, runId);
    return {
      run: {
        id: run.id,
        projectId: run.projectId,
        status: run.status,
        epicText: run.epicText,
        existingEpicKey: run.existingEpicKey,
        clarificationsWritten: run.clarificationsWritten,
        draftVersion: run.draftVersion,
        completedAt: run.completedAt,
      },
      documents: documents.map((doc) => ({ id: doc.id, filename: doc.filename, kind: doc.kind, charCount: doc.charCount })),
      checks: { structure: run.structure, roster: run.roster, assignableUsers: run.assignableUsers },
      questions: questions.map((entry) => ({ ...entry.question, resolution: entry.resolution })),
    };
  }

  /** One document's parsed sections, for the extracted-text view. Sections are null once the retention purge has removed them. */
  async getDocument(runId: string, docId: string) {
    const document = await getRunDocument(this.deps.db, runId, docId);
    return { id: document.id, filename: document.filename, kind: document.kind, sections: document.sections };
  }

  /** The runs of a project, newest first. The epic text is cut to its first line and is empty once purged. */
  async listRuns(projectId: string): Promise<RunListItem[]> {
    const rows = await listProjectRuns(this.deps.db, projectId);
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      createdByName: row.createdByName,
      epicFirstLine: firstLineOf(row.epicText),
    }));
  }

  /**
   * The review screen's state. `actingUserId` is the viewer: the existing epic is read from Jira with
   * their token, never the creator's. That lookup is best effort; the provider may be missing.
   */
  async getReview(runId: string, actingUserId: string): Promise<ReviewView> {
    const { db } = this.deps;
    const run = await getRun(db, runId);
    await touch(db, runId);
    const project = await getProject(db, run.projectId);
    const state = await this.draftStateOf(run);
    const requiredFields = requiredFieldsOf(structureOf(run));
    const stored = await listQuestions(db, runId);

    return {
      ...state,
      requiredFields,
      provider: await this.providerOrNull(project),
      existingEpic:
        run.existingEpicKey === null ? null : await this.existingEpic(actingUserId, project, run.existingEpicKey, runId),
      clarificationsPreview: clarificationsTextOf(stored),
    };
  }

  /** The draft after an edit: no Jira and no provider lookups. */
  async getDraftState(runId: string): Promise<DraftState> {
    return this.draftStateOf(await getRun(this.deps.db, runId));
  }

  private async draftStateOf(run: Run): Promise<DraftState> {
    const items = await loadDraft(this.deps.db, run.id);
    return {
      status: run.status,
      draftVersion: run.draftVersion,
      items,
      blockers: computeBlockers(items, requiredFieldsOf(structureOf(run)), { existingEpic: run.existingEpicKey !== null }),
      assignableUsers: run.assignableUsers ?? [],
    };
  }

  private async providerOrNull(project: Project): Promise<ProviderDescription | null> {
    try {
      return await describeProvider(this.deps.db, project);
    } catch (error) {
      if (error instanceof NoProviderError) return null;
      throw error;
    }
  }

  /**
   * The epic summary, read with the acting user access. A Jira or network failure gives a null summary
   * so the review still opens; losing the Jira sign-in still propagates, since the user must sign in again.
   */
  private async existingEpic(
    userId: string,
    project: Project,
    key: string,
    runId: string,
  ): Promise<{ key: string; summary: string | null }> {
    try {
      const adapter = await this.deps.adapterFor(userId, project);
      const issue = await adapter.getIssue(key);
      return { key, summary: issue?.summary ?? null };
    } catch (error) {
      if (error instanceof ReauthRequiredError) throw error;
      safeLog("run.epic_lookup_failed", { runId, errorCode: error instanceof Error ? error.name : "unknown" });
      return { key, summary: null };
    }
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

    const blockers = computeBlockers(await loadDraft(db, runId), requiredFields, {
      existingEpic: run.existingEpicKey !== null,
    });
    if (blockers.length > 0) throw new CreateBlockedError(blockers);

    // The claim is the only guard against two creations running at once. It re-checks the status atomically.
    const gapMs = this.deps.retryGapMs ?? RETRY_GAP_MS;
    if (!(await claimCreation(db, runId, gapMs))) throw await this.claimRefusal(runId, gapMs);

    let adapter: TicketingAdapter | null = null;
    try {
      adapter = await this.deps.adapterFor(userId, project);
      const meta = await adapter.getProjectMeta(project.jiraProjectKey);
      const acceptedByName = await userDisplayName(db, userId);
      const stored = await listQuestions(db, runId);
      const items = await loadDraft(db, runId);

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
      else await this.settleUnfinished(runId, adapter, project.jiraProjectKey);
      safeLog("run.tickets", { runId, count: summary.created, status: (await getRun(db, runId)).status });
      return summary;
    } catch (error) {
      await this.settleUnfinished(runId, adapter, project.jiraProjectKey);
      throw error;
    } finally {
      await this.releaseLock(runId);
    }
  }

  /** Why the creation claim was refused, as a state error the caller can show. */
  private async claimRefusal(runId: string, gapMs: number): Promise<RunStateError> {
    const current = await getRun(this.deps.db, runId);
    if (!["review", "creating"].includes(current.status)) {
      return new RunStateError("Tickets can only be created from a reviewed draft");
    }
    if (isCreationLocked(current)) {
      const minutes = creationLockMinutesLeft(current);
      return new RunStateError(
        `Creation already in progress, or wait up to ${minutes} minute${minutes === 1 ? "" : "s"} if a previous attempt crashed`,
      );
    }
    if (isWithinRetryGap(current, gapMs)) {
      return new RunStateError("Jira is still indexing the last attempt. Try again in a few seconds.");
    }
    return new RunStateError("Creation already in progress");
  }

  /**
   * After a creation that did not finish, decides the run status from Jira, not only from recorded keys.
   * The run returns to review only when no item has a key and Jira holds nothing under the run label;
   * otherwise it stays creating, so Retry can recover the issues by label. If the label lookup fails the run
   * stays creating, which keeps Retry available. Never throws: the original error is what the caller needs.
   */
  private async settleUnfinished(runId: string, adapter: TicketingAdapter | null, projectKey: string): Promise<void> {
    try {
      const { db } = this.deps;
      if (activeItems(await loadDraft(db, runId)).some((item) => item.jiraKey !== null)) return;
      // Without an adapter nothing could have been sent to Jira.
      if (adapter !== null && (await adapter.findIssuesByLabel(projectKey, runLabel(runId))).length > 0) return;
      await updateRun(db, runId, { status: "review" });
    } catch {
      safeLog("run.settle_failed", { runId, errorCode: "settle_failed" });
    }
  }

  /** Clears the creation lock. A failure is logged, so it cannot replace the error that ended the creation. */
  private async releaseLock(runId: string): Promise<void> {
    try {
      await releaseCreation(this.deps.db, runId);
    } catch {
      safeLog("run.release_failed", { runId, errorCode: "release_failed" });
    }
  }
}
