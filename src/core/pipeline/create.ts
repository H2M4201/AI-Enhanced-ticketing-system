import { computeBlockers, type Blocker } from "@/core/blockers";
import type { DraftItem, ItemKind } from "@/core/domain";
import { componentIdsFor } from "@/core/pipeline/route";
import type { ResolvedStructure } from "@/core/pipeline/structure";
import { activeItems } from "@/core/tree";
import {
  markerFooter,
  type CreateResult,
  type NewIssue,
  type ProjectMeta,
  type TicketingAdapter,
} from "@/core/ticketing/adapter";

/** Jira accepts at most this many issues per bulk create request. */
const BULK_LIMIT = 50;
const PARENT_NOT_CREATED = "Parent was not created";

export class CreateBlockedError extends Error {
  readonly blockers: Blocker[];

  constructor(blockers: Blocker[]) {
    super(`${blockers.length} item(s) must be resolved before creating tickets`);
    this.name = "CreateBlockedError";
    this.blockers = blockers;
  }
}

/** The label that marks every issue created by one run. */
export function runLabel(runId: string): string {
  return `ai-run-${runId.slice(0, 8)}`;
}

export type CreateArgs = {
  adapter: TicketingAdapter;
  meta: ProjectMeta;
  projectKey: string;
  runId: string;
  items: DraftItem[];
  structure: ResolvedStructure;
  existingEpicKey: string | null;
  clarificationsText: string;
  clarificationsWritten: boolean;
  acceptedByName: string;
  requiredFields: Record<ItemKind, { key: string; name: string }[]>;
  onItemCreated: (itemId: string, key: string) => Promise<void>;
  onItemFailed: (itemId: string, error: string) => Promise<void>;
  onClarificationsWritten: () => Promise<void>;
};

export type CreateSummary = { created: number; failed: number; skipped: number };

type Pending = {
  item: DraftItem;
  issue: NewIssue;
  /** Set for standard-level tasks: the story to link the new task to. */
  link?: { toKey: string; linkType: string };
  /** Runs after Jira created the issue, before its key is recorded. */
  beforeRecorded?: () => Promise<void>;
};

function isAcceptedSuggestion(item: DraftItem): boolean {
  return item.origin === "ai_suggestion" && item.suggestionStatus === "accepted";
}

/**
 * A link error is non-fatal when the adapter reports an HTTP status other than 401 or 403.
 * Network errors (no status) and auth errors still abort the run.
 */
function isNonFatalLinkError(error: unknown): error is { status: number } {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = error.status;
  return typeof status === "number" && status !== 401 && status !== 403;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an epic description already holds the clarifications: the heading and first bullet. */
function clarificationsPresent(description: string, clarificationsText: string): boolean {
  const [heading, firstBullet] = clarificationsText.split("\n");
  const probe = firstBullet === undefined ? heading : `${heading}\n${firstBullet}`;
  return description.includes(probe);
}

/** Body, then acceptance criteria, sources and the marker footer, in that order. */
function assembleDescription(item: DraftItem, body: string, acceptedByName: string): string {
  const sections: string[] = [];
  if (isAcceptedSuggestion(item)) sections.push(`Proposed by AI and accepted by ${acceptedByName}.`);
  if (body !== "") sections.push(body);
  if (item.acceptanceCriteria.length > 0) {
    sections.push(`Acceptance criteria:\n${item.acceptanceCriteria.map((ac) => `- [ ] ${ac}`).join("\n")}`);
  }
  if (item.sourceRefs.length > 0) sections.push(`Sources: ${item.sourceRefs.join(", ")}`);
  sections.push(markerFooter(item.id));
  return sections.join("\n\n");
}

/**
 * Creates the reviewed draft in Jira. Re-running it is safe: items that already have a
 * key are skipped, and issues a crashed run created in Jira are recovered by label and
 * marker before anything is sent.
 */
export async function createInTicketing(args: CreateArgs): Promise<CreateSummary> {
  const { adapter, meta, projectKey, structure, requiredFields } = args;

  const draftEpic = args.items.find((item) => item.kind === "epic");
  if (args.existingEpicKey !== null && draftEpic?.jiraKey != null && draftEpic.jiraKey !== args.existingEpicKey) {
    throw new Error(
      `Epic key mismatch: the draft epic is ${draftEpic.jiraKey} but the run expects ${args.existingEpicKey}`,
    );
  }

  const blockers = computeBlockers(args.items, requiredFields);
  if (blockers.length > 0) throw new CreateBlockedError(blockers);

  const label = runLabel(args.runId);
  const active = activeItems(args.items);
  const byId = new Map(active.map((item) => [item.id, item]));
  const epic = active.find((item) => item.kind === "epic");
  if (!epic) throw new Error("The draft has no epic");

  const keys = new Map<string, string>();
  const summary: CreateSummary = { created: 0, failed: 0, skipped: 0 };
  let clarificationsWritten = args.clarificationsWritten;

  for (const item of active) {
    if (item.jiraKey !== null) {
      keys.set(item.id, item.jiraKey);
      summary.skipped++;
    }
  }

  const recordExisting = async (item: DraftItem, key: string): Promise<void> => {
    keys.set(item.id, key);
    summary.skipped++;
    await args.onItemCreated(item.id, key);
  };
  const markClarificationsWritten = async (): Promise<void> => {
    await args.onClarificationsWritten();
    clarificationsWritten = true;
  };

  // Recover issues a crashed run created in Jira before it could save their keys.
  for (const found of await adapter.findIssuesByLabel(projectKey, label)) {
    if (found.marker === null) continue;
    const item = byId.get(found.marker);
    if (!item || keys.has(item.id)) continue;
    await recordExisting(item, found.key);
    // A recovered epic was created with its clarifications already in the description.
    if (item.kind === "epic" && args.clarificationsText !== "" && !clarificationsWritten) {
      await markClarificationsWritten();
    }
  }

  const fail = async (item: DraftItem, error: string): Promise<void> => {
    summary.failed++;
    await args.onItemFailed(item.id, error);
  };

  const createBatch = async (batch: Pending[]): Promise<void> => {
    for (let start = 0; start < batch.length; start += BULK_LIMIT) {
      const chunk = batch.slice(start, start + BULK_LIMIT);
      const results = await adapter.createIssues(chunk.map((p) => p.issue));
      const byRef = new Map<string, CreateResult>(results.map((r) => [r.clientRef, r]));
      for (const pending of chunk) {
        const result = byRef.get(pending.item.id);
        if (result?.ok === true) {
          const { key } = result;
          keys.set(pending.item.id, key);
          if (pending.beforeRecorded) await pending.beforeRecorded();
          await args.onItemCreated(pending.item.id, key);
          if (!pending.link) {
            summary.created++;
            continue;
          }
          try {
            await adapter.linkIssues(key, pending.link.toKey, pending.link.linkType);
            summary.created++;
          } catch (error) {
            if (!isNonFatalLinkError(error)) throw error;
            // The task exists under its key, so only the link is reported as failed.
            summary.failed++;
            await args.onItemFailed(
              pending.item.id,
              `Created as ${key} but linking to its story failed: ${messageOf(error)}`,
            );
          }
        } else {
          await fail(pending.item, result?.ok === false ? result.error : "Jira returned no result");
        }
      }
    }
  };

  const issueFor = (item: DraftItem, typeId: string, body: string, parentKey: string | undefined): NewIssue => ({
    clientRef: item.id,
    projectKey: args.projectKey,
    issueTypeId: typeId,
    summary: item.title,
    description: assembleDescription(item, body, args.acceptedByName),
    parentKey,
    assigneeAccountId: item.routing?.accountId ?? undefined,
    labels: ["ai-backlog", label, ...(isAcceptedSuggestion(item) ? ["ai-suggested"] : [])],
    componentIds: componentIdsFor(item, meta),
    fieldValues: item.fieldValues,
  });

  // Epic
  if (args.existingEpicKey !== null) {
    if (!keys.has(epic.id)) await recordExisting(epic, args.existingEpicKey);
    if (!clarificationsWritten && args.clarificationsText !== "") {
      // A crash after the append but before the flag was saved leaves the text in place.
      const current = await adapter.getIssue(args.existingEpicKey);
      if (!current || !clarificationsPresent(current.description, args.clarificationsText)) {
        await adapter.appendToDescription(args.existingEpicKey, `\n${args.clarificationsText}`);
      }
      await markClarificationsWritten();
    }
  } else if (!keys.has(epic.id)) {
    const writesClarifications = args.clarificationsText !== "" && !clarificationsWritten;
    const body =
      args.clarificationsText !== "" ? `${epic.description}\n\n${args.clarificationsText}` : epic.description;
    await createBatch([
      {
        item: epic,
        issue: issueFor(epic, structure.epic.id, body, undefined),
        beforeRecorded: writesClarifications ? markClarificationsWritten : undefined,
      },
    ]);
  }

  // Stories, created before any task so the tasks can reference their keys.
  const epicKey = keys.get(epic.id);
  const storyBatch: Pending[] = [];
  for (const story of active.filter((i) => i.kind === "story" && !keys.has(i.id))) {
    if (epicKey === undefined) {
      await fail(story, PARENT_NOT_CREATED);
      continue;
    }
    storyBatch.push({ item: story, issue: issueFor(story, structure.story.id, story.description, epicKey) });
  }
  await createBatch(storyBatch);

  // Tasks: under the story, or under the epic with a link to the story.
  const linkType = structure.plan.taskLinkType;
  const taskBatch: Pending[] = [];
  for (const task of active.filter((i) => i.kind === "task" && !keys.has(i.id))) {
    const storyKey = task.parentId === null ? undefined : keys.get(task.parentId);
    if (storyKey === undefined) {
      await fail(task, PARENT_NOT_CREATED);
      continue;
    }
    const viaEpic = structure.taskParent === "epic";
    const parentKey = viaEpic ? epicKey : storyKey;
    const link = viaEpic && linkType !== "" ? { toKey: storyKey, linkType } : undefined;
    taskBatch.push({
      item: task,
      issue: issueFor(task, structure.task.id, task.description, parentKey),
      link,
    });
  }
  await createBatch(taskBatch);

  return summary;
}
