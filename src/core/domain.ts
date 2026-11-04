import { z } from "zod";

export const SectionSchema = z.object({
  ref: z.string(),
  heading: z.string().nullable(),
  text: z.string(),
});
export type Section = z.infer<typeof SectionSchema>;

export const ParsedDocumentSchema = z.object({
  filename: z.string(),
  kind: z.enum(["docx", "pptx", "pdf", "md", "txt"]),
  sections: z.array(SectionSchema),
});
export type ParsedDocument = z.infer<typeof ParsedDocumentSchema>;

export const ItemKindSchema = z.enum(["epic", "story", "task"]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const RoutingSchema = z.object({
  status: z.enum(["assigned", "needs_decision"]),
  accountId: z.string().nullable(),
  displayName: z.string().nullable(),
  teamName: z.string().nullable(),
  reason: z.string(),
  ruleId: z.string().nullable(),
  ruleQuote: z.string().nullable(),
  ruleLine: z.number().nullable(),
  overridden: z.boolean(),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const DraftItemSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  position: z.number(),
  kind: ItemKindSchema,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  estimate: z.number().nullable(),
  sourceRefs: z.array(z.string()),
  origin: z.enum(["from_docs", "ai_suggestion"]),
  assumption: z.boolean(),
  shapedBy: z.array(z.string()),
  suggestionStatus: z.enum(["pending", "accepted", "rejected"]).nullable(),
  routing: RoutingSchema.nullable(),
  fieldValues: z.record(z.string(), z.unknown()),
  jiraKey: z.string().nullable(),
  createError: z.string().nullable(),
});
export type DraftItem = z.infer<typeof DraftItemSchema>;

export const QuestionCategorySchema = z.enum(["contradiction", "ambiguity", "missing"]);
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;

export const ClarifyingQuestionSchema = z.object({
  id: z.string(),
  category: QuestionCategorySchema,
  text: z.string(),
  sourceRefs: z.array(z.string()),
  rank: z.number(),
});
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;

export const ResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answered"), answer: z.string() }),
  z.object({ kind: z.literal("out_of_scope") }),
  z.object({ kind: z.literal("judgment") }),
]);
export type Resolution = z.infer<typeof ResolutionSchema>;

export const StructurePlanSchema = z.object({
  specified: z.boolean(),
  epicType: z.string(),
  storyType: z.string(),
  taskType: z.string(),
  taskLinkType: z.string().default("Relates"),
  notes: z.array(z.string()),
});
export type StructurePlan = z.infer<typeof StructurePlanSchema>;

export const RosterRuleSchema = z.object({
  id: z.string(),
  condition: z.string(),
  target: z.object({ type: z.enum(["person", "team"]), name: z.string() }),
  line: z.number(),
  quote: z.string(),
});
export type RosterRule = z.infer<typeof RosterRuleSchema>;

export const RosterSchema = z.object({
  teams: z.array(
    z.object({
      name: z.string(),
      defaultPerson: z.string(),
      members: z.array(z.string()),
    }),
  ),
  people: z.array(z.object({ name: z.string(), role: z.string().nullable() })),
  rules: z.array(RosterRuleSchema),
});
export type Roster = z.infer<typeof RosterSchema>;
