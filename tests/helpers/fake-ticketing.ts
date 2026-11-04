import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  AssignableUser,
  CreateResult,
  IssueLevel,
  IssueSummary,
  IssueTypeMeta,
  NewIssue,
  ProjectMeta,
  TicketingAdapter,
} from "@/core/ticketing/adapter";
import { readMarker } from "@/core/ticketing/adapter";

export const ProjectMetaSchema: z.ZodType<ProjectMeta> = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  issueTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.enum(["epic", "standard", "subtask"]),
      requiredFields: z.array(z.object({ key: z.string(), name: z.string() })),
      estimateFieldKey: z.string().nullable().optional(),
    }) satisfies z.ZodType<IssueTypeMeta>,
  ),
  components: z.array(z.object({ id: z.string(), name: z.string() })),
  linkTypes: z.array(z.string()),
});

export const AssignableUserSchema: z.ZodType<AssignableUser> = z.object({
  accountId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
});

export const FakeSampleSchema = z.object({
  projectMeta: ProjectMetaSchema,
  users: z.array(AssignableUserSchema),
});
export type FakeSample = z.infer<typeof FakeSampleSchema>;

export type FakeIssue = {
  key: string;
  issueTypeId: string;
  issueTypeName: string;
  summary: string;
  description: string;
  parentKey: string | null;
  labels: string[];
  assigneeAccountId: string | null;
  componentIds: string[];
  fieldValues: Record<string, unknown>;
};

export type FakeLink = { fromKey: string; toKey: string; linkType: string };

const SAMPLE_PATH = new URL("../../samples/fake-jira-project.json", import.meta.url);

/** In-memory TicketingAdapter for tests and scripts/eval.ts. Never imported from runtime paths. */
export class FakeTicketingAdapter implements TicketingAdapter {
  readonly projectMeta: ProjectMeta;
  readonly users: AssignableUser[];
  readonly issues: FakeIssue[] = [];
  readonly links: FakeLink[] = [];
  /** clientRef → error message. Creates for these clientRefs fail without storing anything. */
  readonly failNext = new Map<string, string>();
  /** clientRefs whose issue is stored, after which createIssues throws (crash before the key is saved). */
  readonly failAfterCreate = new Set<string>();

  private nextNumber = 1;

  constructor(sample: { projectMeta: ProjectMeta; users: AssignableUser[] }) {
    this.projectMeta = sample.projectMeta;
    this.users = sample.users;
  }

  async getProjectMeta(projectKey: string): Promise<ProjectMeta> {
    if (projectKey !== this.projectMeta.key) throw new Error(`Project ${projectKey} not found`);
    return this.projectMeta;
  }

  async listAssignableUsers(_projectKey: string): Promise<AssignableUser[]> {
    return [...this.users];
  }

  async createIssues(issues: NewIssue[]): Promise<CreateResult[]> {
    const results: CreateResult[] = [];
    for (const issue of issues) {
      const failure = this.failNext.get(issue.clientRef);
      if (failure !== undefined) {
        results.push({ clientRef: issue.clientRef, ok: false, error: failure });
        continue;
      }
      const type = this.projectMeta.issueTypes.find((t) => t.id === issue.issueTypeId);
      if (!type) {
        results.push({ clientRef: issue.clientRef, ok: false, error: "Unknown issue type" });
        continue;
      }
      if (issue.assigneeAccountId && !this.users.some((u) => u.accountId === issue.assigneeAccountId)) {
        results.push({ clientRef: issue.clientRef, ok: false, error: "User cannot be assigned" });
        continue;
      }
      if (issue.parentKey && !this.issues.some((i) => i.key === issue.parentKey)) {
        results.push({ clientRef: issue.clientRef, ok: false, error: `Parent ${issue.parentKey} does not exist` });
        continue;
      }

      const key = `${issue.projectKey}-${this.nextNumber++}`;
      this.issues.push({
        key,
        issueTypeId: type.id,
        issueTypeName: type.name,
        summary: issue.summary,
        description: issue.description,
        parentKey: issue.parentKey ?? null,
        labels: [...issue.labels],
        assigneeAccountId: issue.assigneeAccountId ?? null,
        componentIds: [...(issue.componentIds ?? [])],
        fieldValues: { ...issue.fieldValues },
      });
      if (this.failAfterCreate.has(issue.clientRef)) {
        throw new Error(`Simulated crash after creating ${key}`);
      }
      results.push({ clientRef: issue.clientRef, ok: true, key });
    }
    return results;
  }

  async findIssuesByLabel(projectKey: string, label: string): Promise<{ key: string; marker: string | null }[]> {
    return this.issues
      .filter((i) => i.key.startsWith(`${projectKey}-`) && i.labels.includes(label))
      .map((i) => ({ key: i.key, marker: readMarker(i.description) }));
  }

  async linkIssues(fromKey: string, toKey: string, linkType: string): Promise<void> {
    this.links.push({ fromKey, toKey, linkType });
  }

  async getIssue(key: string): Promise<IssueSummary | null> {
    const issue = this.issues.find((i) => i.key === key);
    if (!issue) return null;
    const type = this.projectMeta.issueTypes.find((t) => t.id === issue.issueTypeId);
    const level: IssueLevel = type?.level ?? "standard";
    return { key: issue.key, summary: issue.summary, level, description: issue.description };
  }

  async appendToDescription(key: string, text: string): Promise<void> {
    const issue = this.issues.find((i) => i.key === key);
    if (!issue) throw new Error(`Issue ${key} not found`);
    issue.description += text;
  }

  async canBrowseProject(projectKey: string): Promise<boolean> {
    return projectKey === this.projectMeta.key;
  }
}

/** Loads samples/fake-jira-project.json into a fresh FakeTicketingAdapter. */
export function fakeFromSample(): FakeTicketingAdapter {
  const sample = FakeSampleSchema.parse(JSON.parse(readFileSync(SAMPLE_PATH, "utf8")));
  return new FakeTicketingAdapter(sample);
}
