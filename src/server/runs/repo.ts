import { and, asc, eq, inArray } from "drizzle-orm";
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
import { NotFoundError } from "@/server/errors";

export type Run = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type RunPatch = Partial<RunInsert>;
export type DocumentRow = typeof runDocuments.$inferSelect;
export type ProjectFileRow = typeof projectFiles.$inferSelect;

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

/** Replaces the whole draft in one transaction. */
export async function saveDraft(db: Db, runId: string, items: DraftItem[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(draftItems).where(eq(draftItems.runId, runId));
    if (items.length > 0) await tx.insert(draftItems).values(items.map((item) => toRow(runId, item)));
  });
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
