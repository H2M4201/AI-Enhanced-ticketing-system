/** Jira Cloud implementation of TicketingAdapter, over REST v3. */

import {
  ALWAYS_SET_FIELDS,
  type AssignableUser,
  type CreateResult,
  type IssueLevel,
  type IssueSummary,
  type IssueTypeMeta,
  type NewIssue,
  type ProjectMeta,
  readMarker,
  type TicketingAdapter,
} from "@/core/ticketing/adapter";
import { type AdfDoc, adfToText, textToAdf } from "@/integrations/jira/adf";
import { JiraError, JiraHttp } from "@/integrations/jira/client";

const BULK_CHUNK = 50;
const USER_PAGE = 100;
const CREATEMETA_PAGE = 50;
const SEARCH_PAGE = 100;
const PROJECT_PAGE = 50;

type ProjectSearchPage = { values: { id: string; key: string; name: string }[]; isLast: boolean };

type JiraProject = {
  id: string;
  key: string;
  name: string;
  components?: { id: string; name: string }[];
  issueTypes: { id: string; name: string; hierarchyLevel: number }[];
};

type CreateMetaField = { fieldId: string; name: string; required: boolean; hasDefaultValue?: boolean };
type CreateMetaPage = { fields?: CreateMetaField[]; values?: CreateMetaField[]; total?: number };

type JiraUser = { accountId: string; displayName: string; emailAddress?: string; accountType: string };

type BulkElementError = {
  status: number;
  elementErrors?: { errorMessages?: string[]; errors?: Record<string, string> };
  failedElementNumber: number;
};
type BulkCreateResponse = {
  issues?: { id: string; key: string; self: string }[];
  errors?: BulkElementError[];
};

type SearchPage = {
  issues?: { key: string; fields: { description: AdfDoc | null } }[];
  nextPageToken?: string;
  isLast?: boolean;
};

type JiraIssue = {
  key: string;
  fields: {
    summary: string;
    issuetype: { hierarchyLevel?: number };
    description: AdfDoc | null;
  };
};

/** Jira's hierarchy: above 0 is epic, 0 is standard, below 0 is subtask. */
function levelOf(hierarchyLevel: number): IssueLevel {
  if (hierarchyLevel > 0) return "epic";
  if (hierarchyLevel < 0) return "subtask";
  return "standard";
}

const enc = encodeURIComponent;

/** Quotes a value for JQL, escaping backslashes and double quotes. */
function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toIssueUpdate(issue: NewIssue) {
  const fields: Record<string, unknown> = {
    ...issue.fieldValues,
    project: { key: issue.projectKey },
    issuetype: { id: issue.issueTypeId },
    summary: issue.summary,
    description: textToAdf(issue.description),
    labels: issue.labels,
  };
  if (issue.parentKey) fields.parent = { key: issue.parentKey };
  if (issue.assigneeAccountId) fields.assignee = { accountId: issue.assigneeAccountId };
  if (issue.componentIds?.length) fields.components = issue.componentIds.map((id) => ({ id }));
  return { fields };
}

function elementErrorText(e: BulkElementError): string {
  const parts = [...(e.elementErrors?.errorMessages ?? []), ...Object.values(e.elementErrors?.errors ?? {})];
  return parts.length > 0 ? parts.join("; ") : `Jira rejected this item (status ${e.status})`;
}

function hasErrorList(body: unknown): body is BulkCreateResponse {
  return typeof body === "object" && body !== null && Array.isArray((body as { errors?: unknown }).errors);
}

/** Maps a bulk response (2xx, or a 400 carrying the same shape) back to the chunk's clientRefs. */
function mapBulkResponse(chunk: NewIssue[], res: BulkCreateResponse): CreateResult[] {
  const failures = new Map<number, string>();
  for (const e of res.errors ?? []) failures.set(e.failedElementNumber, elementErrorText(e));

  // Successful issues come back in input order, skipping the failed elements.
  const created = res.issues ?? [];
  let nextCreated = 0;
  return chunk.map((item, index): CreateResult => {
    const failure = failures.get(index);
    if (failure !== undefined) return { clientRef: item.clientRef, ok: false, error: failure };
    const made = created[nextCreated++];
    return made
      ? { clientRef: item.clientRef, ok: true, key: made.key }
      : { clientRef: item.clientRef, ok: false, error: "Jira did not return an issue for this item" };
  });
}

function isNotFound(err: unknown): boolean {
  return err instanceof JiraError && err.status === 404;
}

export class JiraCloudAdapter implements TicketingAdapter {
  private readonly http: JiraHttp;

  constructor(http: JiraHttp) {
    this.http = http;
  }

  async getProjectMeta(projectKey: string): Promise<ProjectMeta> {
    const project = await this.http.request<JiraProject>("GET", `/rest/api/3/project/${enc(projectKey)}`);
    const issueTypes: IssueTypeMeta[] = [];
    for (const t of project.issueTypes) {
      issueTypes.push({
        id: t.id,
        name: t.name,
        level: levelOf(t.hierarchyLevel),
        requiredFields: await this.requiredFields(projectKey, t.id),
      });
    }
    const links = await this.http.request<{ issueLinkTypes: { name: string }[] }>(
      "GET",
      "/rest/api/3/issueLinkType",
    );
    return {
      id: project.id,
      key: project.key,
      name: project.name,
      issueTypes,
      components: (project.components ?? []).map((c) => ({ id: c.id, name: c.name })),
      linkTypes: links.issueLinkTypes.map((l) => l.name),
    };
  }

  async listAssignableUsers(projectKey: string): Promise<AssignableUser[]> {
    const users: AssignableUser[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.http.request<JiraUser[]>(
        "GET",
        `/rest/api/3/user/assignable/search?project=${enc(projectKey)}&maxResults=${USER_PAGE}&startAt=${startAt}`,
      );
      for (const u of page) {
        if (u.accountType !== "atlassian") continue;
        users.push({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress ?? null });
      }
      if (page.length < USER_PAGE) return users;
      startAt += page.length;
    }
  }

  async createIssues(issues: NewIssue[]): Promise<CreateResult[]> {
    const results: CreateResult[] = [];
    for (let i = 0; i < issues.length; i += BULK_CHUNK) {
      try {
        results.push(...(await this.createChunk(issues.slice(i, i + BULK_CHUNK))));
      } catch (err) {
        if (!(err instanceof JiraError)) throw err;
        // Nothing created yet and not authorized: let the caller prompt re-authentication.
        const authFailure = results.length === 0 && (err.status === 401 || err.status === 403);
        if (authFailure) throw err;
        // Keep earlier chunks' results; the rest of the items fail with this chunk-level message.
        for (const item of issues.slice(i)) {
          results.push({ clientRef: item.clientRef, ok: false, error: err.message });
        }
        return results;
      }
    }
    return results;
  }

  async findIssuesByLabel(projectKey: string, label: string): Promise<{ key: string; marker: string | null }[]> {
    const found: { key: string; marker: string | null }[] = [];
    let nextPageToken: string | undefined;
    do {
      const body: Record<string, unknown> = {
        jql: `project = ${jqlString(projectKey)} AND labels = ${jqlString(label)}`,
        fields: ["description"],
        maxResults: SEARCH_PAGE,
      };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const page = await this.http.request<SearchPage>("POST", "/rest/api/3/search/jql", body);
      for (const issue of page.issues ?? []) {
        const description = issue.fields.description;
        found.push({ key: issue.key, marker: description ? readMarker(adfToText(description)) : null });
      }
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken);
    return found;
  }

  async linkIssues(fromKey: string, toKey: string, linkType: string): Promise<void> {
    await this.http.request<void>("POST", "/rest/api/3/issueLink", {
      type: { name: linkType },
      inwardIssue: { key: fromKey },
      outwardIssue: { key: toKey },
    });
  }

  async getIssue(key: string): Promise<IssueSummary | null> {
    try {
      const issue = await this.http.request<JiraIssue>(
        "GET",
        `/rest/api/3/issue/${enc(key)}?fields=summary,issuetype,description`,
      );
      return {
        key: issue.key,
        summary: issue.fields.summary,
        level: levelOf(issue.fields.issuetype.hierarchyLevel ?? 0),
        description: issue.fields.description ? adfToText(issue.fields.description) : "",
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async appendToDescription(key: string, text: string): Promise<void> {
    const issue = await this.http.request<JiraIssue>("GET", `/rest/api/3/issue/${enc(key)}?fields=description`);
    const current: AdfDoc = issue.fields.description ?? { type: "doc", version: 1, content: [] };
    const merged: AdfDoc = { type: "doc", version: 1, content: [...current.content, ...textToAdf(text).content] };
    await this.http.request<void>("PUT", `/rest/api/3/issue/${enc(key)}`, { fields: { description: merged } });
  }

  async canBrowseProject(projectKey: string): Promise<boolean> {
    try {
      const res = await this.http.request<{ permissions: { BROWSE_PROJECTS?: { havePermission: boolean } } }>(
        "GET",
        `/rest/api/3/mypermissions?projectKey=${enc(projectKey)}&permissions=BROWSE_PROJECTS`,
      );
      return res.permissions.BROWSE_PROJECTS?.havePermission === true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Jira projects the token can see. A Jira-only query: it is not part of TicketingAdapter. */
  async listProjects(): Promise<{ id: string; key: string; name: string }[]> {
    const projects: { id: string; key: string; name: string }[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.http.request<ProjectSearchPage>(
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${PROJECT_PAGE}`,
      );
      for (const p of page.values) projects.push({ id: p.id, key: p.key, name: p.name });
      if (page.isLast || page.values.length === 0) return projects;
      startAt += page.values.length;
    }
  }

  private async createChunk(chunk: NewIssue[]): Promise<CreateResult[]> {
    let res: BulkCreateResponse;
    try {
      res = await this.http.request<BulkCreateResponse>("POST", "/rest/api/3/issue/bulk", {
        issueUpdates: chunk.map(toIssueUpdate),
      });
    } catch (err) {
      // Jira answers 400 with the same shape when every element in the request fails.
      if (err instanceof JiraError && err.status === 400 && hasErrorList(err.body)) {
        res = err.body;
      } else {
        throw err;
      }
    }
    return mapBulkResponse(chunk, res);
  }

  private async requiredFields(projectKey: string, issueTypeId: string): Promise<{ key: string; name: string }[]> {
    const alwaysSet: readonly string[] = ALWAYS_SET_FIELDS;
    const fields = await this.createMetaFields(projectKey, issueTypeId);
    return fields
      .filter((f) => f.required && !f.hasDefaultValue && !alwaysSet.includes(f.fieldId))
      .map((f) => ({ key: f.fieldId, name: f.name }));
  }

  private async createMetaFields(projectKey: string, issueTypeId: string): Promise<CreateMetaField[]> {
    const all: CreateMetaField[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.http.request<CreateMetaPage>(
        "GET",
        `/rest/api/3/issue/createmeta/${enc(projectKey)}/issuetypes/${enc(issueTypeId)}?startAt=${startAt}&maxResults=${CREATEMETA_PAGE}`,
      );
      // Jira's docs have used both keys, so accept either.
      const items = page.fields ?? page.values ?? [];
      all.push(...items);
      startAt += items.length;
      const more = page.total !== undefined ? startAt < page.total : items.length === CREATEMETA_PAGE;
      if (items.length === 0 || !more) return all;
    }
  }
}
