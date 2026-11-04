import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  ClarifyingQuestionSchema,
  DraftItemSchema,
  ResolutionSchema,
  type ClarifyingQuestion,
  type DraftItem,
  type Resolution,
} from "@/core/domain";
import type { Db } from "@/server/db/client";
import { clarifyingQuestions, draftItems, projectFiles, runDocuments, runs, users } from "@/server/db/schema";
import { NotFoundError, RunStateError } from "@/server/errors";

export type Run = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type RunPatch = Partial<RunInsert>;
export type DocumentRow = typeof runDocuments.$inferSelect;
export type ProjectFileRow = typeof projectFiles.$inferSelect;

/** A ticket creation whose lock is older than this is treated as abandoned and can be taken over. */
export const CREATION_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** A retry waits this long after the last attempt ended: Jira search is eventually consistent, and an early retry can duplicate issues. */
export const RETRY_GAP_MS = 10 * 1000;

const STALE_DRAFT_MESSAGE = "Draft changed in another tab — reload";

function creationLockCutoff(): Date {
  return new Date(Date.now() - CREATION_LOCK_TIMEOUT_MS);
}

/** Whether a ticket creation currently holds the run. */
export function isCreationLocked(run: Run): boolean {
  return run.creatingSince !== null && run.creatingSince.getTime() > Date.now() - CREATION_LOCK_TIMEOUT_MS;
}

/** Whole minutes (at least 1) until an unexpired creation lock times out, or 0 when none holds the run. */
export function creationLockMinutesLeft(run: Run): number {
  if (!isCreationLocked(run) || run.creatingSince === null) return 0;
  const left = run.creatingSince.getTime() + CREATION_LOCK_TIMEOUT_MS - Date.now();
  return Math.max(1, Math.ceil(left / 60_000));
}

/** Whether the last creation attempt ended too recently to start another. */
export function isWithinRetryGap(run: Run, gapMs: number = RETRY_GAP_MS): boolean {
  return run.lastCreateFinishedAt !== null && run.lastCreateFinishedAt.getTime() > Date.now() - gapMs;
}

/** A stored question with its row id, its domain id (Q<rank>) and its resolution once given. */
export type StoredQuestion = {
  rowId: string;
  question: ClarifyingQuestion;
  resolution: Resolution | null;
};

export async function insertRun(db: Db, values: RunInsert): Promise<Run> {
  const [row] = await db.insert(runs).values(values).returning();
  return row;
}

export async function getRun(db: Db, runId: string): Promise<Run> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!row) throw new NotFoundError("Run");
  return row;
}

export async function updateRun(db: Db, runId: string, patch: RunPatch): Promise<void> {
  await db.update(runs).set(patch).where(eq(runs.id, runId));
}

/** Records activity on a run. Every service call does this. */
export async function touch(db: Db, runId: string): Promise<void> {
  await updateRun(db, runId, { lastActivityAt: new Date() });
}

export async function insertDocument(db: Db, values: typeof runDocuments.$inferInsert): Promise<DocumentRow> {
  const [row] = await db.insert(runDocuments).values(values).returning();
  return row;
}

export async function listDocuments(db: Db, runId: string): Promise<DocumentRow[]> {
  return db.select().from(runDocuments).where(eq(runDocuments.runId, runId)).orderBy(asc(runDocuments.filename));
}

/** One document of a run. Looked up by both ids, so a document of another run is not found. */
export async function getRunDocument(db: Db, runId: string, docId: string): Promise<DocumentRow> {
  const [row] = await db
    .select()
    .from(runDocuments)
    .where(and(eq(runDocuments.id, docId), eq(runDocuments.runId, runId)));
  if (!row) throw new NotFoundError("Document");
  return row;
}

export async function deleteDocument(db: Db, runId: string, docId: string): Promise<void> {
  const deleted = await db
    .delete(runDocuments)
    .where(and(eq(runDocuments.id, docId), eq(runDocuments.runId, runId)))
    .returning({ id: runDocuments.id });
  if (deleted.length === 0) throw new NotFoundError("Document");
}

/** Replaces the run's questions. Ranks are 1..n, so each question's domain id is Q<rank>. */
export async function replaceQuestions(db: Db, runId: string, questions: ClarifyingQuestion[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(clarifyingQuestions).where(eq(clarifyingQuestions.runId, runId));
    if (questions.length > 0) {
      await tx.insert(clarifyingQuestions).values(
        questions.map((q) => ({
          runId,
          category: q.category,
          text: q.text,
          sourceRefs: q.sourceRefs,
          rank: q.rank,
        })),
      );
    }
  });
}

export async function listQuestions(db: Db, runId: string): Promise<StoredQuestion[]> {
  const rows = await db
    .select()
    .from(clarifyingQuestions)
    .where(eq(clarifyingQuestions.runId, runId))
    .orderBy(asc(clarifyingQuestions.rank));
  return rows.map((row) => ({
    rowId: row.id,
    question: ClarifyingQuestionSchema.parse({
      id: `Q${row.rank}`,
      category: row.category,
      text: row.text,
      sourceRefs: row.sourceRefs,
      rank: row.rank,
    }),
    resolution: row.resolution === null ? null : ResolutionSchema.parse(row.resolution),
  }));
}

export async function saveResolution(db: Db, questionRowId: string, resolution: Resolution): Promise<void> {
  await db.update(clarifyingQuestions).set({ resolution }).where(eq(clarifyingQuestions.id, questionRowId));
}

function toRow(runId: string, item: DraftItem): typeof draftItems.$inferInsert {
  return {
    id: item.id,
    runId,
    parentId: item.parentId,
    position: item.position,
    kind: item.kind,
    title: item.title,
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    estimate: item.estimate,
    sourceRefs: item.sourceRefs,
    origin: item.origin,
    assumption: item.assumption,
    shapedBy: item.shapedBy,
    suggestionStatus: item.suggestionStatus,
    routing: item.routing,
    fieldValues: item.fieldValues,
    jiraKey: item.jiraKey,
    createError: item.createError,
  };
}

async function writeDraftRows(tx: Db, runId: string, items: DraftItem[]): Promise<void> {
  await tx.delete(draftItems).where(eq(draftItems.runId, runId));
  if (items.length > 0) await tx.insert(draftItems).values(items.map((item) => toRow(runId, item)));
}

function bumpVersion() {
  return { draftVersion: sql`${runs.draftVersion} + 1` };
}

/** Replaces the whole draft in one transaction. Used when a draft is generated, which always bumps the version. */
export async function saveDraft(db: Db, runId: string, items: DraftItem[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(runs).set(bumpVersion()).where(eq(runs.id, runId));
    await writeDraftRows(tx, runId, items);
  });
}

/**
 * Replaces the whole draft only if the run is still in review at the expected version.
 * A stale version rolls the transaction back, so a second tab's edit cannot overwrite the first.
 */
export async function saveDraftVersioned(db: Db, runId: string, expectedVersion: number, items: DraftItem[]): Promise<void> {
  await db.transaction(async (tx) => {
    const bumped = await tx
      .update(runs)
      .set(bumpVersion())
      .where(and(eq(runs.id, runId), eq(runs.draftVersion, expectedVersion), eq(runs.status, "review")))
      .returning({ id: runs.id });
    if (bumped.length === 0) throw new RunStateError(STALE_DRAFT_MESSAGE);
    await writeDraftRows(tx, runId, items);
  });
}

/**
 * Writes one item's editable fields while tickets are being created. The item must not have a Jira key,
 * the run must still be creating, and no creation may hold the lock.
 */
export async function saveItemEdit(db: Db, runId: string, expectedVersion: number, item: DraftItem): Promise<void> {
  await db.transaction(async (tx) => {
    const bumped = await tx
      .update(runs)
      .set(bumpVersion())
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.draftVersion, expectedVersion),
          eq(runs.status, "creating"),
          or(isNull(runs.creatingSince), lt(runs.creatingSince, creationLockCutoff())),
        ),
      )
      .returning({ id: runs.id });
    if (bumped.length === 0) throw new RunStateError(STALE_DRAFT_MESSAGE);

    const updated = await tx
      .update(draftItems)
      .set({
        title: item.title,
        description: item.description,
        acceptanceCriteria: item.acceptanceCriteria,
        estimate: item.estimate,
        fieldValues: item.fieldValues,
        routing: item.routing,
        suggestionStatus: item.suggestionStatus,
      })
      .where(and(eq(draftItems.id, item.id), eq(draftItems.runId, runId), isNull(draftItems.jiraKey)))
      .returning({ id: draftItems.id });
    if (updated.length === 0) throw new RunStateError("This item already exists in Jira and cannot be changed");
  });
}

/**
 * Takes the creation lock and moves the run to creating. Returns false when the run is not
 * in review or creating, when another creation holds an unexpired lock, or when the last
 * attempt ended less than `gapMs` ago.
 */
export async function claimCreation(db: Db, runId: string, gapMs: number = RETRY_GAP_MS): Promise<boolean> {
  const claimed = await db
    .update(runs)
    .set({ status: "creating", creatingSince: new Date() })
    .where(
      and(
        eq(runs.id, runId),
        inArray(runs.status, ["review", "creating"]),
        or(isNull(runs.creatingSince), lt(runs.creatingSince, creationLockCutoff())),
        or(isNull(runs.lastCreateFinishedAt), lte(runs.lastCreateFinishedAt, new Date(Date.now() - gapMs))),
      ),
    )
    .returning({ id: runs.id });
  return claimed.length > 0;
}

/** Clears the lock and records when the attempt ended, for the retry gap. */
export async function releaseCreation(db: Db, runId: string): Promise<void> {
  await updateRun(db, runId, { creatingSince: null, lastCreateFinishedAt: new Date() });
}

export type RunListRow = {
  id: string;
  status: Run["status"];
  createdAt: Date;
  createdByName: string;
  epicText: string;
};

/** A project's runs, newest first, with the creator's display name. */
export async function listProjectRuns(db: Db, projectId: string): Promise<RunListRow[]> {
  return db
    .select({
      id: runs.id,
      status: runs.status,
      createdAt: runs.createdAt,
      createdByName: users.displayName,
      epicText: runs.epicText,
    })
    .from(runs)
    .innerJoin(users, eq(users.id, runs.createdBy))
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.createdAt));
}

/** The draft ordered by parent, then position. */
export async function loadDraft(db: Db, runId: string): Promise<DraftItem[]> {
  const rows = await db
    .select()
    .from(draftItems)
    .where(eq(draftItems.runId, runId))
    .orderBy(asc(draftItems.parentId), asc(draftItems.position));
  return rows.map((row) => DraftItemSchema.parse(row));
}

/** Records a created issue. Clears any earlier error for the item. */
export async function setItemCreated(db: Db, itemId: string, jiraKey: string): Promise<void> {
  await db.update(draftItems).set({ jiraKey, createError: null }).where(eq(draftItems.id, itemId));
}

/** Records a failure. An existing Jira key is kept, since a task can exist yet fail to link. */
export async function setItemFailed(db: Db, itemId: string, createError: string): Promise<void> {
  await db.update(draftItems).set({ createError }).where(eq(draftItems.id, itemId));
}

export async function filesByIds(db: Db, ids: string[]): Promise<ProjectFileRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(projectFiles).where(inArray(projectFiles.id, ids));
}

export async function userDisplayName(db: Db, userId: string): Promise<string> {
  const [row] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  if (!row) throw new NotFoundError("User");
  return row.displayName;
}
