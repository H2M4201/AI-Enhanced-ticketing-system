import { z } from "zod";
import type { StructurePlan } from "@/core/domain";
import type { LlmClient } from "@/core/llm/client";
import { escapeAttribute, escapeTagBody } from "@/core/llm/escape";
import { renderPromptMessages } from "@/core/llm/prompts";
import { generateValidated } from "@/core/llm/structured";
import type { IssueTypeMeta, ProjectMeta } from "@/core/ticketing/adapter";

export const FALLBACK_NOTICE = "Guidelines don't define a ticket structure; using Epic → Story → Sub-task.";

const FALLBACK_EPIC = "Epic";
const FALLBACK_STORY = "Story";
const FALLBACK_TASK = "Sub-task";
const FALLBACK_LINK = "Relates";

/** Model reply: every role is optional so a partial answer can be completed from the fallback. */
const ExtractionReplySchema = z.object({
  specified: z.boolean(),
  epicType: z.string().optional(),
  storyType: z.string().optional(),
  taskType: z.string().optional(),
  taskLinkType: z.string().optional(),
  notes: z.array(z.string()).optional(),
});

export type ResolvedStructure = {
  plan: StructurePlan;
  epic: IssueTypeMeta;
  story: IssueTypeMeta;
  task: IssueTypeMeta;
  taskParent: "story" | "epic";
};

function fallbackPlan(): StructurePlan {
  return {
    specified: false,
    epicType: FALLBACK_EPIC,
    storyType: FALLBACK_STORY,
    taskType: FALLBACK_TASK,
    taskLinkType: FALLBACK_LINK,
    notes: [FALLBACK_NOTICE],
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Asks the model which issue types the guidelines use for the epic, story and task roles.
 * Guidelines that say nothing about structure give the fallback plan.
 */
export async function extractStructure(
  llm: LlmClient,
  guidelines: { filename: string; content: string }[],
): Promise<StructurePlan> {
  if (guidelines.length === 0) return fallbackPlan();

  const block = guidelines
    .map((g) => `<guideline file="${escapeAttribute(g.filename)}">\n${escapeTagBody(g.content, "guideline")}\n</guideline>`)
    .join("\n\n");
  const messages = renderPromptMessages("structure", { guidelines: block });

  const reply = await generateValidated(
    llm,
    ExtractionReplySchema,
    messages,
    { step: "structure" },
  );
  if (!reply.specified) return fallbackPlan();

  const notes = [...(reply.notes ?? [])];
  const fill = (value: string | undefined, role: string, fallback: string): string => {
    const found = clean(value);
    if (found) return found;
    notes.push(`Guidelines did not name a ${role}; using ${fallback}.`);
    return fallback;
  };

  return {
    specified: true,
    epicType: fill(reply.epicType, "epic type", FALLBACK_EPIC),
    storyType: fill(reply.storyType, "story type", FALLBACK_STORY),
    taskType: fill(reply.taskType, "task type", FALLBACK_TASK),
    taskLinkType: fill(reply.taskLinkType, "task link type", FALLBACK_LINK),
    notes,
  };
}

/**
 * Checks the plan's type names against the Jira project. Names match case-insensitively.
 * For a standard-level task type, the resolved plan carries the link type to use
 * (or "" when the project has no link types). For a sub-task type, no link is used.
 */
export function validateStructure(
  plan: StructurePlan,
  meta: ProjectMeta,
):
  | { ok: true; resolved: ResolvedStructure; warnings: string[] }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const available = meta.issueTypes.map((t) => t.name).join(", ");
  const levelName = (level: IssueTypeMeta["level"]): string =>
    ({ epic: "epic-level", standard: "standard-level", subtask: "sub-task-level" })[level];

  const lookup = (name: string): IssueTypeMeta | undefined => {
    const wanted = name.trim().toLowerCase();
    const found = meta.issueTypes.find((t) => t.name.toLowerCase() === wanted);
    if (!found) {
      errors.push(`Guidelines ask for issue type "${name}" but project ${meta.key} has none. Available: ${available}`);
    }
    return found;
  };

  const epic = lookup(plan.epicType);
  if (epic && epic.level !== "epic") {
    errors.push(`The epic role needs an epic-level type, but "${epic.name}" is ${levelName(epic.level)} in project ${meta.key}.`);
  }

  const story = lookup(plan.storyType);
  if (story && story.level !== "standard") {
    errors.push(`The story role needs a standard-level type, but "${story.name}" is ${levelName(story.level)} in project ${meta.key}.`);
  }

  const task = lookup(plan.taskType);
  if (task && task.level === "epic") {
    errors.push(`The task role needs a standard or sub-task level type, but "${task.name}" is epic-level in project ${meta.key}.`);
  }

  if (errors.length > 0 || !epic || !story || !task) return { ok: false, errors };

  let resolvedPlan: StructurePlan = { ...plan, epicType: epic.name, storyType: story.name, taskType: task.name };
  let taskParent: "story" | "epic" = "story";

  if (task.level === "standard") {
    taskParent = "epic";
    const wanted = plan.taskLinkType.trim();
    const match = meta.linkTypes.find((l) => l.toLowerCase() === wanted.toLowerCase());
    if (match) {
      resolvedPlan = { ...resolvedPlan, taskLinkType: match };
    } else {
      const fallback = meta.linkTypes[0] ?? "";
      warnings.push(
        fallback
          ? `Guidelines ask for link type "${wanted}" but project ${meta.key} has none. Using "${fallback}".`
          : `Guidelines ask for link type "${wanted}" but project ${meta.key} has none. Tasks will not be linked.`,
      );
      resolvedPlan = { ...resolvedPlan, taskLinkType: fallback };
    }
  }

  return { ok: true, resolved: { plan: resolvedPlan, epic, story, task, taskParent }, warnings };
}
