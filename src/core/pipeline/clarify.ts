import { z } from "zod";
import {
  type ClarifyingQuestion,
  type ParsedDocument,
  type Resolution,
  QuestionCategorySchema,
} from "@/core/domain";
import type { LlmClient } from "@/core/llm/client";
import { escapeAttribute, escapeTagBody } from "@/core/llm/escape";
import { renderPrompt } from "@/core/llm/prompts";
import { generateValidated } from "@/core/llm/structured";

export type PipelineInputs = {
  epicText: string;
  documents: ParsedDocument[];
  guidelines: { filename: string; content: string }[];
};

const MAX_QUESTIONS = 10;

/** Model reply: ids and final ranks are assigned here, not by the model. */
const QuestionReplySchema = z.object({
  questions: z.array(
    z.object({
      category: QuestionCategorySchema,
      text: z.string(),
      sourceRefs: z.array(z.string()),
      rank: z.number(),
    }),
  ),
});

/** Renders each document as a <document> block. Every section is "[ref] heading" then its text. */
export function formatDocuments(docs: ParsedDocument[]): string {
  return docs
    .map((doc) => {
      const body = doc.sections
        .map((section) => {
          const label = section.heading ? `[${section.ref}] ${section.heading}` : `[${section.ref}]`;
          return `${label}\n${section.text}`;
        })
        .join("\n\n");
      return `<document file="${escapeAttribute(doc.filename)}">\n${escapeTagBody(body, "document")}\n</document>`;
    })
    .join("\n\n");
}

/** Renders each guideline as a <guideline> block. */
export function formatGuidelines(guidelines: { filename: string; content: string }[]): string {
  return guidelines
    .map((g) => `<guideline file="${escapeAttribute(g.filename)}">\n${escapeTagBody(g.content, "guideline")}\n</guideline>`)
    .join("\n\n");
}

function knownRefs(documents: ParsedDocument[]): Set<string> {
  return new Set(documents.flatMap((doc) => doc.sections.map((section) => section.ref)));
}

/**
 * Asks the model for the contradictions, ambiguities and gaps that would change the breakdown.
 * Source refs not present in the inputs are dropped. Questions are ranked, capped at 10,
 * and given ids Q1..Qn.
 */
export async function generateQuestions(llm: LlmClient, inputs: PipelineInputs): Promise<ClarifyingQuestion[]> {
  const prompt = renderPrompt("clarify", {
    epic: `<epic>\n${escapeTagBody(inputs.epicText, "epic")}\n</epic>`,
    documents: formatDocuments(inputs.documents),
    guidelines: formatGuidelines(inputs.guidelines),
  });

  const reply = await generateValidated(
    llm,
    QuestionReplySchema,
    [{ role: "system", content: prompt }],
    { step: "clarify" },
  );

  const refs = knownRefs(inputs.documents);
  const ranked = [...reply.questions]
    .map((q) => ({ ...q, sourceRefs: q.sourceRefs.filter((ref) => refs.has(ref)) }))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_QUESTIONS);

  return ranked.map((q, i) => ({
    id: `Q${i + 1}`,
    category: q.category,
    text: q.text,
    sourceRefs: q.sourceRefs,
    rank: i + 1,
  }));
}

function answerText(resolution: Resolution | undefined): string {
  if (!resolution) return "Unresolved";
  switch (resolution.kind) {
    case "answered":
      return resolution.answer;
    case "out_of_scope":
      return "Out of scope";
    case "judgment":
      return "Left to judgment (see Assumption tickets)";
  }
}

/** Renders the questions and their resolutions as a "## Clarifications" section. */
export function formatClarifications(
  questions: ClarifyingQuestion[],
  resolutions: Record<string, Resolution>,
): string {
  const lines = questions.map((q) => {
    const resolution: Resolution | undefined = resolutions[q.id];
    return `- ${q.text} → ${answerText(resolution)}`;
  });
  return ["## Clarifications", ...lines].join("\n");
}
