import {
  ParsedDocumentSchema,
  RosterSchema,
  type ItemKind,
  type ParsedDocument,
  type Resolution,
  type Roster,
} from "@/core/domain";
import { formatClarifications, type PipelineInputs } from "@/core/pipeline/clarify";
import type { ResolvedStructure } from "@/core/pipeline/structure";
import type { Db } from "@/server/db/client";
import { RunStateError } from "@/server/errors";
import { filesByIds, listDocuments, type Run, type StoredQuestion } from "@/server/runs/repo";

export type RunFile = { filename: string; content: string };

/** The guidelines and routing file a run recorded when it was created. */
export type RunFiles = { guidelines: RunFile[]; routing: RunFile | null };

export const EMPTY_ROSTER: Roster = { teams: [], people: [], rules: [] };

/** Loads the run's documents with their parsed sections. A purged document makes the run unusable, never empty text. */
export async function loadDocuments(db: Db, runId: string): Promise<ParsedDocument[]> {
  const rows = await listDocuments(db, runId);
  if (rows.some((row) => row.deletedAt !== null || row.sections === null)) {
    throw new RunStateError("Documents were deleted by retention policy. Start a new breakdown.");
  }
  return rows.map((row) => ParsedDocumentSchema.parse({ filename: row.filename, kind: row.kind, sections: row.sections }));
}

/** Loads the files recorded on the run by id, so later uploads do not change an existing run. */
export async function loadRunFiles(db: Db, run: Run): Promise<RunFiles> {
  const rows = await filesByIds(db, run.fileVersions.map((version) => version.fileId));
  const guidelines = rows
    .filter((row) => row.kind === "guideline")
    .map((row) => ({ filename: row.filename, content: row.content }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const routingRow = rows.find((row) => row.kind === "routing");
  return {
    guidelines,
    routing: routingRow ? { filename: routingRow.filename, content: routingRow.content } : null,
  };
}

export function pipelineInputs(run: Run, documents: ParsedDocument[], files: RunFiles): PipelineInputs {
  return { epicText: run.epicText, documents, guidelines: files.guidelines };
}

/** The texts whose combined size is checked against the context budget. */
export function budgetParts(epicText: string, documents: ParsedDocument[], guidelines: RunFile[]): string[] {
  return [
    epicText,
    ...documents.flatMap((doc) => doc.sections.map((section) => section.text)),
    ...guidelines.map((guideline) => guideline.content),
  ];
}

export function structureOf(run: Run): ResolvedStructure | null {
  return run.structure as ResolvedStructure | null;
}

export function requireStructure(run: Run): ResolvedStructure {
  const structure = structureOf(run);
  if (structure === null) throw new RunStateError("Run the checks before generating a draft or creating tickets");
  return structure;
}

export function rosterOf(run: Run): Roster {
  return run.roster === null ? EMPTY_ROSTER : RosterSchema.parse(run.roster);
}

export function requiredFieldsOf(structure: ResolvedStructure | null): Record<ItemKind, { key: string; name: string }[]> {
  if (structure === null) return { epic: [], story: [], task: [] };
  return {
    epic: structure.epic.requiredFields,
    story: structure.story.requiredFields,
    task: structure.task.requiredFields,
  };
}

export function resolutionsOf(stored: StoredQuestion[]): Record<string, Resolution> {
  const resolutions: Record<string, Resolution> = {};
  for (const entry of stored) {
    if (entry.resolution !== null) resolutions[entry.question.id] = entry.resolution;
  }
  return resolutions;
}

/** The "## Clarifications" text for the epic, or "" when the run has no questions. */
export function clarificationsTextOf(stored: StoredQuestion[]): string {
  if (stored.length === 0) return "";
  return formatClarifications(
    stored.map((entry) => entry.question),
    resolutionsOf(stored),
  );
}
