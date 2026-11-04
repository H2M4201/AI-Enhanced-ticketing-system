import { z } from "zod";
import type { ClarifyingQuestion, DraftItem, ItemKind, Resolution } from "@/core/domain";
import type { LlmClient } from "@/core/llm/client";
import { escapeTagBody } from "@/core/llm/escape";
import { renderPrompt } from "@/core/llm/prompts";
import { generateValidated } from "@/core/llm/structured";
import { type PipelineInputs, formatClarifications, formatDocuments, formatGuidelines } from "@/core/pipeline/clarify";
import type { ResolvedStructure } from "@/core/pipeline/structure";
import { validateTree } from "@/core/tree";

const MAX_TITLE_LENGTH = 255;

const OriginSchema = z.enum(["from_docs", "ai_suggestion"]);

const TaskReplySchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).optional(),
  sourceRefs: z.array(z.string()),
  origin: OriginSchema,
  assumptionQuestionIds: z.array(z.string()),
  shapedBy: z.array(z.string()),
});

const StoryReplySchema = z.object({
  tempId: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  estimate: z.number().nullable().optional(),
  sourceRefs: z.array(z.string()),
  origin: OriginSchema,
  assumptionQuestionIds: z.array(z.string()),
  shapedBy: z.array(z.string()),
  tasks: z.array(TaskReplySchema),
});

/** Model reply: the epic, then its stories, each with its tasks. Ids and positions are assigned in code. */
export const DraftOutputSchema = z.object({
  epic: z.object({ title: z.string(), description: z.string() }),
  stories: z.array(StoryReplySchema),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

type Source = {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  estimate?: number | null;
  sourceRefs: string[];
  origin: DraftItem["origin"];
  assumptionQuestionIds: string[];
  shapedBy: string[];
};

type MappingContext = {
  validRefs: Set<string>;
  guidelineNames: Set<string>;
  judgmentIds: Set<string>;
  newId: () => string;
};

/** Collapses every whitespace run to one space, trims, and caps at the Jira summary limit. */
function cleanTitle(value: string, kind: ItemKind): string {
  const title = value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH).trim();
  return title === "" ? `Untitled ${kind}` : title;
}

function cleanEntries(values: string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== "");
}

/**
 * Maps one model entry to a DraftItem. Unknown refs and guideline names are dropped. A story or task
 * with no valid ref is downgraded to an AI suggestion. The epic keeps its origin.
 */
function buildItem(
  id: string,
  kind: ItemKind,
  parentId: string | null,
  position: number,
  source: Source,
  ctx: MappingContext,
): DraftItem {
  const sourceRefs = source.sourceRefs.filter((ref) => ctx.validRefs.has(ref));
  const ungrounded = kind !== "epic" && source.origin === "from_docs" && sourceRefs.length === 0;
  const origin: DraftItem["origin"] = ungrounded ? "ai_suggestion" : source.origin;
  return {
    id,
    parentId,
    position,
    kind,
    title: cleanTitle(source.title, kind),
    description: source.description.trim(),
    acceptanceCriteria: cleanEntries(source.acceptanceCriteria ?? []),
    estimate: source.estimate ?? null,
    sourceRefs,
    origin,
    assumption: source.assumptionQuestionIds.some((qid) => ctx.judgmentIds.has(qid)),
    shapedBy: [...new Set(source.shapedBy.filter((name) => ctx.guidelineNames.has(name)))],
    suggestionStatus: origin === "ai_suggestion" ? "pending" : null,
    routing: null,
    fieldValues: {},
    jiraKey: null,
    createError: null,
  };
}

function toDraftItems(reply: DraftOutput, ctx: MappingContext): DraftItem[] {
  const epic = buildItem(
    ctx.newId(),
    "epic",
    null,
    0,
    { ...reply.epic, sourceRefs: [], origin: "from_docs", assumptionQuestionIds: [], shapedBy: [] },
    ctx,
  );
  const items: DraftItem[] = [epic];

  reply.stories.forEach((story, storyPosition) => {
    const storyItem = buildItem(ctx.newId(), "story", epic.id, storyPosition, story, ctx);
    items.push(storyItem);
    story.tasks.forEach((task, taskPosition) => {
      items.push(buildItem(ctx.newId(), "task", storyItem.id, taskPosition, task, ctx));
    });
  });

  return items;
}

function describeStructure(structure: ResolvedStructure): string {
  const { plan } = structure;
  return [
    `Epic issue type: ${plan.epicType}`,
    `Story issue type: ${plan.storyType}`,
    `Task issue type: ${plan.taskType}`,
  ].join("\n");
}

/** Lists the questions the team left to judgment, as "id: question", so the model can cite their ids. */
function describeJudgment(questions: ClarifyingQuestion[], resolutions: Record<string, Resolution>): string {
  const lines = questions
    .filter((q) => resolutions[q.id]?.kind === "judgment")
    .map((q) => `${q.id}: ${q.text.replace(/\s+/g, " ").trim()}`);
  return lines.length > 0 ? lines.join("\n") : "None.";
}

/**
 * Asks the model for the epic → story → task breakdown, then maps the reply to draft items.
 * Items get ids and positions in output order. Throws TreeError if the mapped tree is invalid.
 */
export async function generateDraft(
  llm: LlmClient,
  args: {
    inputs: PipelineInputs;
    questions: ClarifyingQuestion[];
    resolutions: Record<string, Resolution>;
    structure: ResolvedStructure;
    newId?: () => string;
  },
): Promise<DraftItem[]> {
  const { inputs, questions, resolutions, structure } = args;
  const prompt = renderPrompt("draft", {
    epic: `<epic>\n${escapeTagBody(inputs.epicText, "epic")}\n</epic>`,
    documents: formatDocuments(inputs.documents),
    guidelines: formatGuidelines(inputs.guidelines),
    structure: describeStructure(structure),
    clarifications: `<clarifications>\n${escapeTagBody(formatClarifications(questions, resolutions), "clarifications")}\n</clarifications>`,
    judgmentQuestions: `<judgment-questions>\n${escapeTagBody(describeJudgment(questions, resolutions), "judgment-questions")}\n</judgment-questions>`,
  });

  const reply = await generateValidated(
    llm,
    DraftOutputSchema,
    [{ role: "system", content: prompt }],
    { step: "draft" },
  );

  const ctx: MappingContext = {
    validRefs: new Set(inputs.documents.flatMap((doc) => doc.sections.map((section) => section.ref))),
    guidelineNames: new Set(inputs.guidelines.map((g) => g.filename)),
    judgmentIds: new Set(questions.filter((q) => resolutions[q.id]?.kind === "judgment").map((q) => q.id)),
    newId: args.newId ?? (() => crypto.randomUUID()),
  };

  const items = toDraftItems(reply, ctx);
  validateTree(items);
  return items;
}
