import { describe, expect, it, vi } from "vitest";
import type { NewIssue } from "@/core/ticketing/adapter";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraError, JiraHttp } from "@/integrations/jira/client";
import { adfToText, textToAdf } from "@/integrations/jira/adf";

type JsonBody = {
  issueUpdates: { fields: { assignee?: { accountId?: string }; [field: string]: unknown } }[];
  fields?: { description?: { type?: string; content?: unknown } };
  [key: string]: unknown;
};

type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: JsonBody;
  auth: string | null;
};
type Reply = { status?: number; body?: unknown; raw?: string };
type Route = (call: Call) => Reply | undefined;

/** Fake fetch: routes by method + path relative to the cloud base URL. No network. */
function fakeJira(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/ex/jira/cloud-1", ""),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const reply = route(call);
    if (!reply) throw new Error(`Unrouted ${call.method} ${call.path}`);
    const status = reply.status ?? 200;
    if (reply.raw !== undefined) return new Response(reply.raw, { status });
    if (status === 204 || reply.body === undefined) return new Response(null, { status });
    return new Response(JSON.stringify(reply.body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function setup(route: Route, tokens = ["tok"]) {
  const fake = fakeJira(route);
  let next = 0;
  const getToken = vi.fn(async () => tokens[Math.min(next++, tokens.length - 1)]);
  const http = new JiraHttp({ cloudId: "cloud-1", getToken, fetchImpl: fake.fetchImpl });
  return { adapter: new JiraCloudAdapter(http), getToken, ...fake };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const issue = (ref: string, overrides: Partial<NewIssue> = {}): NewIssue => ({
  clientRef: ref,
  projectKey: "CHK",
  issueTypeId: "2",
  summary: `Summary ${ref}`,
  description: "Body",
  labels: ["ai-backlog", "ai-run-1234abcd"],
  ...overrides,
});

const projectBody = {
  id: "10000",
  key: "CHK",
  name: "Checkout",
  components: [{ id: "20000", name: "Web" }],
  issueTypes: [
    { id: "1", name: "Epic", hierarchyLevel: 1 },
    { id: "2", name: "Story", hierarchyLevel: 0 },
    { id: "3", name: "Sub-task", hierarchyLevel: -1 },
  ],
};

const storyFields = [
  { fieldId: "summary", name: "Summary", required: true, hasDefaultValue: false },
  { fieldId: "customfield_10020", name: "Team", required: true, hasDefaultValue: false },
  { fieldId: "priority", name: "Priority", required: true, hasDefaultValue: true },
  { fieldId: "customfield_10100", name: "Notes", required: false, hasDefaultValue: false },
  { fieldId: "customfield_10016", name: "Story point estimate", required: false, schema: { type: "number" } },
  { fieldId: "customfield_10200", name: "Story Points", required: false, schema: { type: "string" } },
];

/** Routes shared by the metadata tests. */
function metaRoute(call: Call): Reply | undefined {
  if (call.method === "GET" && call.path === "/rest/api/3/project/CHK") return { body: projectBody };
  if (call.method === "GET" && call.path === "/rest/api/3/issue/createmeta/CHK/issuetypes/1")
    return { body: { fields: [], total: 0 } };
  if (call.method === "GET" && call.path === "/rest/api/3/issue/createmeta/CHK/issuetypes/2")
    return { body: { fields: storyFields, total: storyFields.length } };
  if (call.method === "GET" && call.path === "/rest/api/3/issue/createmeta/CHK/issuetypes/3")
    return { body: { values: [], total: 0 } };
  if (call.method === "GET" && call.path === "/rest/api/3/issueLinkType")
    return { body: { issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }] } };
  return undefined;
}

describe("JiraCloudAdapter metadata", () => {
  it("maps hierarchy levels and required fields", async () => {
    const { adapter } = setup(metaRoute);
    const m = await adapter.getProjectMeta("CHK");
    expect(m.issueTypes.find((t) => t.name === "Sub-task")!.level).toBe("subtask");
    expect(m.issueTypes.find((t) => t.name === "Epic")!.level).toBe("epic");
    expect(m.issueTypes.find((t) => t.name === "Story")!.requiredFields).toEqual([
      { key: "customfield_10020", name: "Team" },
    ]);
    expect(m.components).toEqual([{ id: "20000", name: "Web" }]);
    expect(m.linkTypes).toEqual(["Blocks"]);
  });

  it("exposes the story-points number field by name, case-insensitively, and ignores non-number fields", async () => {
    const { adapter } = setup(metaRoute);
    const m = await adapter.getProjectMeta("CHK");
    expect(m.issueTypes.find((t) => t.name === "Story")!.estimateFieldKey).toBe("customfield_10016");
    expect(m.issueTypes.find((t) => t.name === "Epic")!.estimateFieldKey).toBeNull();
  });

  it("pages createmeta and accepts a values key", async () => {
    const page1 = range(50).map((i) => ({
      fieldId: `customfield_2${String(i).padStart(4, "0")}`,
      name: `Filler ${i}`,
      required: false,
      hasDefaultValue: false,
    }));
    const page2 = [{ fieldId: "customfield_30000", name: "Market", required: true, hasDefaultValue: false }];
    const { adapter, calls } = setup((c) => {
      if (c.path === "/rest/api/3/project/CHK") return { body: projectBody };
      if (c.path === "/rest/api/3/issueLinkType") return { body: { issueLinkTypes: [] } };
      if (c.path === "/rest/api/3/issue/createmeta/CHK/issuetypes/2") {
        return c.query.get("startAt") === "0"
          ? { body: { values: page1, total: 51 } }
          : { body: { values: page2, total: 51 } };
      }
      if (c.path.startsWith("/rest/api/3/issue/createmeta/CHK/issuetypes/")) return { body: { fields: [] } };
      return undefined;
    });
    const m = await adapter.getProjectMeta("CHK");
    expect(m.issueTypes.find((t) => t.name === "Story")!.requiredFields).toEqual([
      { key: "customfield_30000", name: "Market" },
    ]);
    const createmetaCalls = calls.filter((c) => c.path.includes("/issue/createmeta/CHK/issuetypes/2"));
    expect(createmetaCalls.map((c) => c.query.get("startAt"))).toEqual(["0", "50"]);
    expect(createmetaCalls[0].query.get("maxResults")).toBe("50");
  });

  it("lists only atlassian accounts across pages of 100", async () => {
    const page1 = range(100).map((i) => ({
      accountId: `acc-${i}`,
      displayName: `User ${i}`,
      emailAddress: `u${i}@x.com`,
      accountType: i === 1 ? "app" : "atlassian",
    }));
    const page2 = [
      { accountId: "acc-n", displayName: "Nguyễn Văn A", accountType: "atlassian" },
      { accountId: "acc-c", displayName: "Customer", emailAddress: "c@x.com", accountType: "customer" },
    ];
    const { adapter, calls } = setup((c) => {
      if (c.path !== "/rest/api/3/user/assignable/search") return undefined;
      return { body: c.query.get("startAt") === "0" ? page1 : page2 };
    });
    const users = await adapter.listAssignableUsers("CHK");
    expect(users).toHaveLength(99 + 1);
    expect(users[users.length - 1]).toEqual({ accountId: "acc-n", displayName: "Nguyễn Văn A", email: null });
    expect(calls.map((c) => c.query.get("startAt"))).toEqual(["0", "100"]);
    expect(calls[0].query.get("project")).toBe("CHK");
    expect(calls[0].query.get("maxResults")).toBe("100");
  });
});

describe("JiraCloudAdapter issues", () => {
  it("chunks bulk create by 50 and maps partial errors to clientRef", async () => {
    let key = 0;
    const { adapter, calls } = setup((c) => {
      if (c.method !== "POST" || c.path !== "/rest/api/3/issue/bulk") return undefined;
      const issues: unknown[] = [];
      const errors: unknown[] = [];
      c.body.issueUpdates.forEach((u, i) => {
        if (u.fields.assignee?.accountId === "bad") {
          errors.push({
            status: 400,
            elementErrors: { errorMessages: [], errors: { assignee: "The assignee bad is not assignable to this project" } },
            failedElementNumber: i,
          });
        } else {
          key += 1;
          issues.push({ id: String(key), key: `CHK-${key}`, self: "x" });
        }
      });
      return { status: 201, body: { issues, errors } };
    });
    const items = range(51).map((i) => issue(`c${i}`, i === 3 ? { assigneeAccountId: "bad" } : {}));
    const r = await adapter.createIssues(items);

    expect(calls.filter((c) => c.path === "/rest/api/3/issue/bulk")).toHaveLength(2);
    expect(r).toHaveLength(51);
    expect(r[3]).toEqual({ clientRef: "c3", ok: false, error: expect.stringContaining("assignee") });
    expect(r[2]).toEqual({ clientRef: "c2", ok: true, key: "CHK-3" });
    expect(r[4]).toEqual({ clientRef: "c4", ok: true, key: "CHK-4" });
    expect(r[50]).toEqual({ clientRef: "c50", ok: true, key: "CHK-50" });
  });

  it("maps a 400 where every element failed to per-item errors", async () => {
    const { adapter } = setup((c) => {
      if (c.path !== "/rest/api/3/issue/bulk") return undefined;
      return {
        status: 400,
        body: {
          issues: [],
          errors: [
            { status: 400, failedElementNumber: 0, elementErrors: { errorMessages: [], errors: { assignee: "Assignee is not valid" } } },
            { status: 400, failedElementNumber: 1, elementErrors: { errorMessages: ["Could not create"], errors: { summary: "Summary too long" } } },
            { status: 400, failedElementNumber: 2, elementErrors: { errorMessages: ["Could not create"], errors: {} } },
          ],
        },
      };
    });
    const r = await adapter.createIssues([issue("c0"), issue("c1"), issue("c2")]);
    expect(r).toEqual([
      { clientRef: "c0", ok: false, error: "Assignee is not valid" },
      { clientRef: "c1", ok: false, error: "Could not create; Summary too long" },
      { clientRef: "c2", ok: false, error: "Could not create" },
    ]);
  });

  it("keeps chunk 1 results when chunk 2 is a 400 where every element failed", async () => {
    let key = 0;
    const { adapter } = setup((c) => {
      if (c.path !== "/rest/api/3/issue/bulk") return undefined;
      if (c.body.issueUpdates.length === 50) {
        return {
          status: 201,
          body: {
            issues: range(50).map(() => ({ id: "x", key: `CHK-${++key}`, self: "x" })),
            errors: [],
          },
        };
      }
      return {
        status: 400,
        body: {
          issues: [],
          errors: [{ status: 400, failedElementNumber: 0, elementErrors: { errorMessages: ["Summary is required"], errors: {} } }],
        },
      };
    });
    const r = await adapter.createIssues(range(51).map((i) => issue(`c${i}`)));
    expect(r).toHaveLength(51);
    expect(r.slice(0, 50).every((x) => x.ok)).toBe(true);
    expect(r[0]).toEqual({ clientRef: "c0", ok: true, key: "CHK-1" });
    expect(r[50]).toEqual({ clientRef: "c50", ok: false, error: "Summary is required" });
  });

  it("keeps chunk 1 results and fails the rest without throwing when chunk 2 is a 500", async () => {
    let key = 0;
    const { adapter } = setup((c) => {
      if (c.path !== "/rest/api/3/issue/bulk") return undefined;
      if (c.body.issueUpdates.length === 50) {
        return {
          status: 201,
          body: { issues: range(50).map(() => ({ id: "x", key: `CHK-${++key}`, self: "x" })), errors: [] },
        };
      }
      return { status: 500, body: { errorMessages: ["Server down"], errors: {} } };
    });
    const r = await adapter.createIssues(range(51).map((i) => issue(`c${i}`)));
    expect(r).toHaveLength(51);
    expect(r.slice(0, 50).every((x) => x.ok)).toBe(true);
    expect(r[50]).toEqual({ clientRef: "c50", ok: false, error: "Server down" });
  });

  it("throws JiraError when the first chunk is forbidden", async () => {
    const { adapter } = setup((c) =>
      c.path === "/rest/api/3/issue/bulk" ? { status: 403, body: { errorMessages: ["No permission"], errors: {} } } : undefined,
    );
    const err = await adapter.createIssues([issue("c0")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err).toMatchObject({ status: 403, messages: ["No permission"] });
  });

  it("sends the bulk create fields with parent, assignee and components when given", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.path !== "/rest/api/3/issue/bulk") return undefined;
      return { status: 201, body: { issues: [{ id: "1", key: "CHK-7", self: "x" }], errors: [] } };
    });
    const r = await adapter.createIssues([
      issue("c0", {
        parentKey: "CHK-1",
        assigneeAccountId: "acc-1",
        componentIds: ["20000"],
        fieldValues: { customfield_10020: "Team A" },
      }),
    ]);
    expect(r).toEqual([{ clientRef: "c0", ok: true, key: "CHK-7" }]);
    expect(calls[0].body).toEqual({
      issueUpdates: [
        {
          fields: {
            project: { key: "CHK" },
            issuetype: { id: "2" },
            summary: "Summary c0",
            description: textToAdf("Body"),
            parent: { key: "CHK-1" },
            assignee: { accountId: "acc-1" },
            labels: ["ai-backlog", "ai-run-1234abcd"],
            components: [{ id: "20000" }],
            customfield_10020: "Team A",
          },
        },
      ],
    });
  });

  it("omits optional fields that were not given and makes no call for an empty list", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.path !== "/rest/api/3/issue/bulk") return undefined;
      return { status: 201, body: { issues: [{ id: "1", key: "CHK-8", self: "x" }], errors: [] } };
    });
    expect(await adapter.createIssues([])).toEqual([]);
    expect(calls).toHaveLength(0);
    await adapter.createIssues([issue("c0")]);
    expect(calls[0].body.issueUpdates[0].fields).not.toHaveProperty("parent");
    expect(calls[0].body.issueUpdates[0].fields).not.toHaveProperty("assignee");
    expect(calls[0].body.issueUpdates[0].fields).not.toHaveProperty("components");
  });

  it("appendToDescription keeps existing content", async () => {
    const existing = textToAdf("Original text\n\nai-backlog-item: item-1");
    const { adapter, calls } = setup((c) => {
      if (c.method === "GET" && c.path === "/rest/api/3/issue/CHK-1") {
        return { body: { key: "CHK-1", fields: { description: existing } } };
      }
      if (c.method === "PUT" && c.path === "/rest/api/3/issue/CHK-1") return { status: 204 };
      return undefined;
    });
    await adapter.appendToDescription("CHK-1", "## Clarifications\n- Q1: guests?");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body.fields?.description?.type).toBe("doc");
    expect(put.body.fields?.description?.content).toEqual([
      ...existing.content,
      ...textToAdf("## Clarifications\n- Q1: guests?").content,
    ]);
  });

  it("findIssuesByLabel reads markers across pages", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.method !== "POST" || c.path !== "/rest/api/3/search/jql") return undefined;
      if (c.body.nextPageToken === "p2") return { body: { issues: [], isLast: true } };
      return {
        body: {
          issues: [
            { key: "CHK-9", fields: { description: textToAdf("Some text\n\nai-backlog-item: item-1") } },
            { key: "CHK-10", fields: { description: null } },
          ],
          nextPageToken: "p2",
        },
      };
    });
    expect(await adapter.findIssuesByLabel("CHK", "ai-run-1234abcd")).toEqual([
      { key: "CHK-9", marker: "item-1" },
      { key: "CHK-10", marker: null },
    ]);
    expect(calls[0].body).toEqual({
      jql: 'project = "CHK" AND labels = "ai-run-1234abcd"',
      fields: ["description"],
      maxResults: 100,
    });
  });

  it("linkIssues posts the inward and outward issues", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.method === "POST" && c.path === "/rest/api/3/issueLink") return { status: 201 };
      return undefined;
    });
    await expect(adapter.linkIssues("CHK-1", "CHK-2", "Blocks")).resolves.toBeUndefined();
    expect(calls[0].body).toEqual({
      type: { name: "Blocks" },
      inwardIssue: { key: "CHK-1" },
      outwardIssue: { key: "CHK-2" },
    });
  });

  it("getIssue returns a summary, and null for a 404", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.path === "/rest/api/3/issue/CHK-1") {
        return {
          body: {
            key: "CHK-1",
            fields: {
              summary: "Epic one",
              issuetype: { hierarchyLevel: 1 },
              description: textToAdf("Desc"),
            },
          },
        };
      }
      if (c.path === "/rest/api/3/issue/CHK-404") {
        return { status: 404, body: { errorMessages: ["Issue does not exist"], errors: {} } };
      }
      return undefined;
    });
    expect(await adapter.getIssue("CHK-1")).toEqual({
      key: "CHK-1",
      summary: "Epic one",
      level: "epic",
      description: "Desc",
    });
    expect(calls[0].query.get("fields")).toBe("summary,issuetype,description");
    expect(await adapter.getIssue("CHK-404")).toBeNull();
  });

  it("canBrowseProject reads the permission and treats 404 as no access", async () => {
    const { adapter, calls } = setup((c) => {
      if (c.path !== "/rest/api/3/mypermissions") return undefined;
      return c.query.get("projectKey") === "CHK"
        ? { body: { permissions: { BROWSE_PROJECTS: { havePermission: true } } } }
        : { status: 404, body: { errorMessages: ["Not found"], errors: {} } };
    });
    expect(await adapter.canBrowseProject("CHK")).toBe(true);
    expect(calls[0].query.get("permissions")).toBe("BROWSE_PROJECTS");
    expect(await adapter.canBrowseProject("NOPE")).toBe(false);
  });
});

describe("JiraCloudAdapter projects", () => {
  it("lists projects across pages until isLast", async () => {
    const page1 = { values: range(50).map((i) => ({ id: `${i}`, key: `P${i}`, name: `Project ${i}` })), isLast: false, startAt: 0 };
    const page2 = { values: [{ id: "99", key: "NGU", name: "Nguyễn Dự Án" }], isLast: true, startAt: 50 };
    const { adapter, calls } = setup((c) => {
      if (c.path !== "/rest/api/3/project/search") return undefined;
      return { body: c.query.get("startAt") === "0" ? page1 : page2 };
    });
    const projects = await adapter.listProjects();
    expect(projects).toHaveLength(51);
    expect(projects[0]).toEqual({ id: "0", key: "P0", name: "Project 0" });
    expect(projects[50]).toEqual({ id: "99", key: "NGU", name: "Nguyễn Dự Án" });
    expect(calls.map((c) => c.query.get("startAt"))).toEqual(["0", "50"]);
    expect(calls[0].query.get("maxResults")).toBe("50");
  });
});

describe("JiraHttp", () => {
  it("retries once with a new token on 401", async () => {
    const { adapter, calls, getToken } = setup(
      (c) => {
        if (c.path !== "/rest/api/3/mypermissions") return undefined;
        return c.auth === "Bearer old"
          ? { status: 401, body: { errorMessages: ["expired"], errors: {} } }
          : { body: { permissions: { BROWSE_PROJECTS: { havePermission: true } } } };
      },
      ["old", "new"],
    );
    expect(await adapter.canBrowseProject("CHK")).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("throws JiraError with the status and messages after a second 401", async () => {
    const { adapter, getToken } = setup(
      (c) => (c.path === "/rest/api/3/project/CHK" ? { status: 401, body: { errorMessages: ["nope"], errors: {} } } : undefined),
      ["a", "b"],
    );
    const err = await adapter.getProjectMeta("CHK").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err).toMatchObject({ status: 401, messages: ["nope"] });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("combines errorMessages and errors values into JiraError messages", async () => {
    const { adapter } = setup((c) =>
      c.path === "/rest/api/3/issueLink"
        ? { status: 400, body: { errorMessages: ["Bad link"], errors: { type: "Unknown link type" } } }
        : undefined,
    );
    const err = await adapter.linkIssues("CHK-1", "CHK-2", "Nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err).toMatchObject({ status: 400, messages: ["Bad link", "Unknown link type"] });
  });

  it("throws JiraError for a 2xx response with a non-JSON body", async () => {
    const { adapter } = setup((c) => (c.path === "/rest/api/3/project/CHK" ? { raw: "<html>oops</html>" } : undefined));
    const err = await adapter.getProjectMeta("CHK").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err).toMatchObject({ status: 200, messages: ["Invalid JSON response from Jira"] });
  });

  it("keeps the parsed body on JiraError", async () => {
    const body = { issues: [], errors: [{ status: 400, failedElementNumber: 0, elementErrors: { errorMessages: ["Summary is required"], errors: {} } }] };
    const { adapter } = setup((c) => (c.path === "/rest/api/3/issueLink" ? { status: 400, body } : undefined));
    const err = await adapter.linkIssues("CHK-1", "CHK-2", "Blocks").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(err).toMatchObject({ status: 400, body, messages: ["Summary is required"] });
  });

  it("returns undefined for a 204 response", async () => {
    const { adapter } = setup((c) => (c.path === "/rest/api/3/issueLink" ? { status: 204 } : undefined));
    await expect(adapter.linkIssues("CHK-1", "CHK-2", "Blocks")).resolves.toBeUndefined();
  });
});

describe("ADF text in issue descriptions", () => {
  it("round-trips the description text that appendToDescription sends", () => {
    expect(adfToText(textToAdf("## Clarifications\n- Q1"))).toBe("## Clarifications\n- Q1");
  });
});
