/** Ticketing adapter contract. Pure TypeScript: no Jira or framework imports. */

export type IssueLevel = "epic" | "standard" | "subtask";

export type IssueTypeMeta = {
  id: string;
  name: string;
  level: IssueLevel;
  /** Excludes the fields the app always sets (see ALWAYS_SET_FIELDS). */
  requiredFields: { key: string; name: string }[];
};

/** Fields the app always sets itself, so they never appear in requiredFields. */
export const ALWAYS_SET_FIELDS = [
  "project",
  "issuetype",
  "summary",
  "description",
  "parent",
  "assignee",
  "labels",
  "components",
  "reporter",
] as const;

export type ProjectMeta = {
  id: string;
  key: string;
  name: string;
  issueTypes: IssueTypeMeta[];
  components: { id: string; name: string }[];
  linkTypes: string[];
};

export type AssignableUser = {
  accountId: string;
  displayName: string;
  email: string | null;
};

export type NewIssue = {
  /** Draft item id. */
  clientRef: string;
  projectKey: string;
  issueTypeId: string;
  summary: string;
  description: string;
  parentKey?: string;
  assigneeAccountId?: string;
  labels: string[];
  componentIds?: string[];
  fieldValues?: Record<string, unknown>;
};

export type CreateResult =
  | { clientRef: string; ok: true; key: string }
  | { clientRef: string; ok: false; error: string };

export type IssueSummary = {
  key: string;
  summary: string;
  level: IssueLevel;
  description: string;
};

export interface TicketingAdapter {
  getProjectMeta(projectKey: string): Promise<ProjectMeta>;
  listAssignableUsers(projectKey: string): Promise<AssignableUser[]>;
  createIssues(issues: NewIssue[]): Promise<CreateResult[]>;
  findIssuesByLabel(
    projectKey: string,
    label: string,
  ): Promise<{ key: string; marker: string | null }[]>;
  linkIssues(fromKey: string, toKey: string, linkType: string): Promise<void>;
  getIssue(key: string): Promise<IssueSummary | null>;
  appendToDescription(key: string, text: string): Promise<void>;
  canBrowseProject(projectKey: string): Promise<boolean>;
}

export const MARKER_PREFIX = "ai-backlog-item: ";

/** The final description paragraph that ties a Jira issue back to its draft item. */
export function markerFooter(itemId: string): string {
  return `${MARKER_PREFIX}${itemId}`;
}

/** Returns the draft item id from the last line starting with the marker prefix, or null. */
export function readMarker(description: string): string | null {
  const lines = description.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimEnd();
    if (line.startsWith(MARKER_PREFIX)) {
      const id = line.slice(MARKER_PREFIX.length).trim();
      return id.length > 0 ? id : null;
    }
  }
  return null;
}
