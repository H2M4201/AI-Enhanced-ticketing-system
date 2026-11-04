import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateBlockedError } from "@/core/pipeline/create";
import { LlmOutputError } from "@/core/llm/structured";
import { encryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraError } from "@/integrations/jira/client";
import { APICallError, RetryError } from "ai";
import { clearAccessCache } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { runDeps } from "@/server/deps";
import { handle } from "@/server/http";
import { ForbiddenError, NotFoundError, ReauthRequiredError, RunStateError } from "@/server/errors";
import { users } from "@/server/db/schema";
import { createProfile } from "@/server/providers";
import { createProject, findProjectByKey, setProjectProvider, uploadProjectFile } from "@/server/projects";
import { insertDocument, insertRun, replaceQuestions } from "@/server/runs/repo";
import { testDb } from "../helpers/db";
import type { Db } from "@/server/db/client";

import { GET as getRunDetail } from "@/app/api/runs/[id]/route";
import { POST as postChecks } from "@/app/api/runs/[id]/checks/route";
import { PATCH as patchDraft } from "@/app/api/runs/[id]/draft/route";
import { DELETE as deleteDocument, GET as getDocument } from "@/app/api/runs/[id]/documents/[docId]/route";
import { PUT as putQuestion } from "@/app/api/runs/[id]/questions/[qid]/route";
import { POST as postProjectFile } from "@/app/api/projects/[id]/files/route";
import { DELETE as deleteProjectFile } from "@/app/api/projects/[id]/files/[fileId]/route";
import { PATCH as patchProject, GET as getProject } from "@/app/api/projects/[id]/route";
import { GET as listProjects, POST as createProjectRoute } from "@/app/api/projects/route";
import { GET as listRuns } from "@/app/api/projects/[id]/runs/route";
import { GET as listProviders } from "@/app/api/providers/route";

vi.mock("@/server/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/deps", () => ({ runDeps: vi.fn() }));
// The real function, but a spy, so one test can simulate losing a race on the duplicate check.
vi.mock("@/server/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/projects")>();
  return { ...actual, findProjectByKey: vi.fn(actual.findProjectByKey) };
});

const unused = async (): Promise<never> => {
  throw new Error("not used in this test");
};

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.env.ATLASSIAN_CLIENT_ID = "client-id";
  process.env.ATLASSIAN_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  resetEnvCache();
  clearAccessCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function errorOf(fn: () => Promise<unknown>) {
  const response = await handle(fn);
  return { status: response.status, body: (await response.json()) as { error: Record<string, unknown> } };
}

describe("handle", () => {
  it("maps CreateBlockedError to 409 with its blockers", async () => {
    const blocker = { itemId: "a", type: "missing_field" as const, message: "Story needs a team" };
    const { status, body } = await errorOf(async () => {
      throw new CreateBlockedError([blocker]);
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe("blocked");
    expect(body.error.blockers).toEqual([blocker]);
  });

  it("maps ReauthRequiredError to 401 reauth_required", async () => {
    const { status, body } = await errorOf(async () => {
      throw new ReauthRequiredError();
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe("reauth_required");
  });

  it("maps RunStateError to 409 run_state with its message", async () => {
    const { status, body } = await errorOf(async () => {
      throw new RunStateError("Draft changed in another tab — reload");
    });
    expect(status).toBe(409);
    expect(body.error).toEqual({ code: "run_state", message: "Draft changed in another tab — reload" });
  });

  it("maps NotFoundError to 404 not_found", async () => {
    const { status, body } = await errorOf(async () => {
      throw new NotFoundError("Run");
    });
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "not_found", message: "Run not found" });
  });

  it("maps a zod failure to 400 without echoing the value", async () => {
    const { status, body } = await errorOf(async () => z.object({ n: z.number() }).parse({ n: "secret-value" }));
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });

  it("maps LlmOutputError to 502 with the fixed message", async () => {
    const { status, body } = await errorOf(async () => {
      throw new LlmOutputError("draft", 3, "not json");
    });
    expect(status).toBe(502);
    expect(body.error.message).toBe("The AI returned an unusable answer after 3 tries. Try again or switch model.");
  });

  it("maps JiraError to 502 with Jira's messages", async () => {
    const { status, body } = await errorOf(async () => {
      throw new JiraError(400, ["Assignee cannot be assigned"]);
    });
    expect(status).toBe(502);
    expect(body.error).toEqual({ code: "jira", message: "Assignee cannot be assigned" });
  });

  it("returns a fixed 500 message and logs only the error name, never the thrown text", async () => {
    const write = vi.mocked(process.stdout.write);
    const { status, body } = await errorOf(async () => {
      throw new Error("secret epic text in the message");
    });
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "internal", message: "Something went wrong" });
    const logged = write.mock.calls.map((call) => String(call[0])).join("");
    expect(logged).toContain('"errorCode":"Error"');
    expect(logged).toContain('"step":"api"');
    expect(logged).not.toContain("secret epic text");
  });

  it("maps an AI provider HTTP failure to 502 llm_provider without the request or response body", async () => {
    const failure = new APICallError({
      message: "Bad request: secret prompt text",
      url: "https://llm.example.com/v1/chat/completions",
      requestBodyValues: { messages: "secret prompt text" },
      statusCode: 401,
      responseBody: '{"error":"secret response text"}',
    });
    const { status, body } = await errorOf(async () => {
      throw failure;
    });
    expect(status).toBe(502);
    expect(body.error).toEqual({
      code: "llm_provider",
      message: "The AI provider rejected the request (HTTP 401). Check the provider's URL, key and model.",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("maps a provider failure wrapped in a retry error the same way", async () => {
    const last = new APICallError({ message: "m", url: "https://x", requestBodyValues: {}, statusCode: 503 });
    const { status, body } = await errorOf(async () => {
      throw new RetryError({ message: "Failed after 3 attempts", reason: "maxRetriesExceeded", errors: [last] });
    });
    expect(status).toBe(502);
    expect(body.error.message).toContain("(HTTP 503)");
  });

  it("maps ForbiddenError to 403", async () => {
    const { status } = await errorOf(async () => {
      throw new ForbiddenError("nope");
    });
    expect(status).toBe(403);
  });
});

// One in-memory database for the file: each setup adds rows with unique ids instead of a new database.
let db: Db;
beforeAll(async () => {
  db = await testDb();
});

async function newUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      atlassianAccountId: `${name.toLowerCase()}-${randomUUID()}`,
      displayName: name,
      email: null,
      accessTokenEnc: encryptSecret("access"),
      refreshTokenEnc: encryptSecret("refresh"),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    })
    .returning();
  return row;
}

/** An owner, another user, and a project owned by the owner. The browse check passes for every project. */
async function setup() {
  const owner = await newUser("Owner");
  const other = await newUser("Other");
  const project = await createProject(db, owner.id, {
    name: "Payments",
    cloudId: `cloud-${randomUUID()}`,
    siteUrl: "https://one.atlassian.net",
    jiraProjectKey: "PAY",
  });
  vi.spyOn(JiraCloudAdapter.prototype, "canBrowseProject").mockResolvedValue(true);
  vi.mocked(runDeps).mockResolvedValue({
    db,
    llmFor: unused,
    adapterFor: unused,
    contextTokensFor: unused,
  });
  vi.mocked(requireUser).mockResolvedValue(owner);
  return { owner, other, project };
}

/** Atlassian's accessible-resources answer for the signed-in user. */
function stubSites(sites: { id: string; name: string; url: string }[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).endsWith("/oauth/token/accessible-resources")) return Response.json(sites);
    throw new Error(`unexpected fetch ${String(input)}`);
  });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function reviewRun(projectId: string, createdBy: string) {
  return insertRun(db, {
    projectId,
    createdBy,
    epicText: "Epic text",
    existingEpicKey: null,
    fileVersions: [],
    status: "review",
  });
}

describe("route handlers", () => {
  it("returns 409 run_state when checks are run on a run that is already under review", async () => {
    const { owner, project } = await setup();
    const run = await reviewRun(project.id, owner.id);

    const response = await postChecks(new Request("http://localhost/api/checks", { method: "POST" }), ctx({ id: run.id }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error).toEqual({
      code: "run_state",
      message: "Checks can only run before clarifying questions are generated",
    });
  });

  it("returns 404 not_found for an unknown run", async () => {
    await setup();
    const response = await getRunDetail(
      new Request("http://localhost/api/runs/x"),
      ctx({ id: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 404 not_found, not 500, for an id that is not a uuid", async () => {
    await setup();
    const response = await getRunDetail(new Request("http://localhost/api/runs/abc"), ctx({ id: "abc" }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 404 for a project id that is not a uuid", async () => {
    await setup();
    const response = await getProject(new Request("http://localhost/api/projects/abc"), ctx({ id: "abc" }));
    expect(response.status).toBe(404);
  });

  it("returns 404 for a file id that is not a uuid", async () => {
    const { project } = await setup();
    const response = await deleteProjectFile(
      new Request("http://localhost/api/projects/x/files/abc", { method: "DELETE" }),
      ctx({ id: project.id, fileId: "abc" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 403 for a run when the user cannot browse the project in Jira", async () => {
    const { owner, project } = await setup();
    const run = await reviewRun(project.id, owner.id);
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockResolvedValue(false);

    const response = await getRunDetail(new Request("http://localhost/api/runs/x"), ctx({ id: run.id }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("returns one document's sections through its own run", async () => {
    const { owner, project } = await setup();
    const run = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "A", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const sections = [{ ref: "S1", heading: "Scope", text: "Checkout redesign" }];
    const doc = await insertDocument(db, { runId: run.id, filename: "brief.md", kind: "md", sections, charCount: 17 });

    const response = await getDocument(
      new Request("http://localhost/api/runs/x/documents/y"),
      ctx({ id: run.id, docId: doc.id }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: doc.id, filename: "brief.md", kind: "md", sections });
  });

  it("returns 404 when a document of another run is read through this run", async () => {
    const { owner, project } = await setup();
    const runA = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "A", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const runB = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "B", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const doc = await insertDocument(db, { runId: runB.id, filename: "notes.txt", kind: "txt", sections: [], charCount: 0 });

    const response = await getDocument(
      new Request("http://localhost/api/runs/x/documents/y"),
      ctx({ id: runA.id, docId: doc.id }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 403 when the user cannot browse the project, even for a real document", async () => {
    const { owner, project } = await setup();
    const run = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "A", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const doc = await insertDocument(db, { runId: run.id, filename: "notes.txt", kind: "txt", sections: [], charCount: 0 });
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockResolvedValue(false);

    const response = await getDocument(
      new Request("http://localhost/api/runs/x/documents/y"),
      ctx({ id: run.id, docId: doc.id }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("returns 404 when a document of another run is deleted through this run", async () => {
    const { owner, project } = await setup();
    const runA = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "A", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const runB = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "B", existingEpicKey: null, fileVersions: [], status: "inputs" });
    const doc = await insertDocument(db, { runId: runB.id, filename: "notes.txt", kind: "txt", sections: [], charCount: 0 });

    const response = await deleteDocument(
      new Request("http://localhost/api/runs/x/documents/y", { method: "DELETE" }),
      ctx({ id: runA.id, docId: doc.id }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 404 when a question of another run is answered through this run", async () => {
    const { owner, project } = await setup();
    const runA = await insertRun(db, {
      projectId: project.id,
      createdBy: owner.id,
      epicText: "Epic text",
      existingEpicKey: null,
      fileVersions: [],
      status: "questions",
    });
    const runB = await insertRun(db, {
      projectId: project.id,
      createdBy: owner.id,
      epicText: "Epic text",
      existingEpicKey: null,
      fileVersions: [],
      status: "questions",
    });
    await replaceQuestions(db, runB.id, [
      { id: "Q1", category: "missing", text: "Who pays shipping?", sourceRefs: [], rank: 1 },
    ]);

    const response = await putQuestion(
      jsonRequest("PUT", { kind: "out_of_scope" }),
      ctx({ id: runA.id, qid: "Q1" }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 404 when a file of another project is deleted through this project", async () => {
    const { owner, project } = await setup();
    const otherProject = await createProject(db, owner.id, {
      name: "Checkout",
      cloudId: `cloud-${randomUUID()}`,
      siteUrl: "https://two.atlassian.net",
      jiraProjectKey: "CHK",
    });
    const file = await uploadProjectFile(db, otherProject.id, owner.id, "guideline", "g.md", "Some guideline");

    const response = await deleteProjectFile(
      new Request("http://localhost/api/projects/x/files/y", { method: "DELETE" }),
      ctx({ id: project.id, fileId: file.id }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("returns 403 before reading the body when a non-owner patches a project", async () => {
    const { other, project } = await setup();
    vi.mocked(requireUser).mockResolvedValue(other);

    // The body is invalid, so a 400 here would mean the body was parsed before the owner check.
    const response = await patchProject(jsonRequest("PATCH", { retentionDays: "not a number" }), ctx({ id: project.id }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("returns 403 before reading the body when the user cannot browse the run's project", async () => {
    const { owner, project } = await setup();
    const run = await reviewRun(project.id, owner.id);
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockResolvedValue(false);

    const response = await patchDraft(
      jsonRequest("PATCH", { op: { type: "explode" }, expectedVersion: "x" }),
      ctx({ id: run.id }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("returns 400 for a draft edit whose op is not a known DraftOp", async () => {
    const { owner, project } = await setup();
    const run = await reviewRun(project.id, owner.id);

    const response = await patchDraft(
      jsonRequest("PATCH", { op: { type: "explode", id: "x" }, expectedVersion: 0 }),
      ctx({ id: run.id }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("returns 413 too_large for a project file over 200 KB", async () => {
    const { project } = await setup();
    const form = new FormData();
    form.set("kind", "guideline");
    form.set("file", new File([new Uint8Array(200 * 1024 + 1)], "guidelines.md"));

    const response = await postProjectFile(
      new Request("http://localhost/api/projects/x/files", { method: "POST", body: form }),
      ctx({ id: project.id }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("too_large");
  });

  it("returns 415 unsupported_type for a project file that is not .md or .txt", async () => {
    const { project } = await setup();
    const form = new FormData();
    form.set("kind", "guideline");
    form.set("file", new File(["%PDF-1.4"], "guidelines.pdf", { type: "application/pdf" }));

    const response = await postProjectFile(
      new Request("http://localhost/api/projects/x/files", { method: "POST", body: form }),
      ctx({ id: project.id }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("unsupported_type");
  });

  it("returns the project to a member who can browse it in Jira", async () => {
    const { project } = await setup();
    const response = await getProject(new Request("http://localhost/api/projects/x"), ctx({ id: project.id }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: project.id, jiraProjectKey: "PAY", owned: true, retentionDays: 7 });
    expect(body).not.toHaveProperty("ownerUserId");
  });
});

describe("GET /api/projects/[id]/runs", () => {
  it("lists the project's runs newest first with a capped first line, and an empty line once purged", async () => {
    const { owner, other, project } = await setup();
    const long = `${"x".repeat(200)}
second line`;
    const first = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "\n  Older epic\nmore", existingEpicKey: null, fileVersions: [], createdAt: new Date("2026-01-01T00:00:00Z") });
    const second = await insertRun(db, { projectId: project.id, createdBy: other.id, epicText: long, existingEpicKey: null, fileVersions: [], status: "review", createdAt: new Date("2026-01-02T00:00:00Z") });
    const purged = await insertRun(db, { projectId: project.id, createdBy: owner.id, epicText: "", existingEpicKey: null, fileVersions: [], status: "done", createdAt: new Date("2026-01-03T00:00:00Z") });

    const response = await listRuns(new Request("http://localhost/api/projects/x/runs"), ctx({ id: project.id }));

    expect(response.status).toBe(200);
    const { runs } = await response.json();
    expect(runs.map((r: { id: string }) => r.id)).toEqual([purged.id, second.id, first.id]);
    expect(runs[0]).toMatchObject({ status: "done", createdByName: "Owner", epicFirstLine: "" });
    expect(runs[1]).toMatchObject({ status: "review", createdByName: "Other", epicFirstLine: "x".repeat(120) });
    expect(runs[2].epicFirstLine).toBe("Older epic");
    expect(typeof runs[2].createdAt).toBe("string");
  });

  it("returns 403 when the user cannot browse the project in Jira", async () => {
    const { project } = await setup();
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockResolvedValue(false);

    const response = await listRuns(new Request("http://localhost/api/projects/x/runs"), ctx({ id: project.id }));

    expect(response.status).toBe(403);
  });
});

describe("GET /api/projects", () => {
  it("lists a project the user can browse and leaves out one whose check fails", async () => {
    const { other, project } = await setup();
    const owner = await newUser("Viewer owner");
    const broken = await createProject(db, owner.id, {
      name: "Broken",
      cloudId: project.cloudId,
      siteUrl: project.siteUrl,
      jiraProjectKey: "BAD",
    });
    expect(broken.cloudId).toBe(project.cloudId);
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);
    vi.mocked(requireUser).mockResolvedValue(other);
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockImplementation(async (key: string) => {
      if (key === "BAD") throw new JiraError(500, ["boom"]);
      return key === "PAY";
    });

    const response = await listProjects();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.projects.map((p: { jiraProjectKey: string }) => p.jiraProjectKey)).toEqual(["PAY"]);
    expect(body.projects[0]).toMatchObject({ id: project.id, owned: false });
  });

  it("returns 401 reauth_required when the Atlassian grant has been revoked", async () => {
    const { other, project } = await setup();
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);
    vi.mocked(requireUser).mockResolvedValue(other);
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockRejectedValue(new ReauthRequiredError());

    const response = await listProjects();
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("reauth_required");
  });
});

describe("POST /api/projects", () => {
  it("returns 403 when the user cannot browse the Jira project", async () => {
    const { project } = await setup();
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);
    vi.mocked(JiraCloudAdapter.prototype.canBrowseProject).mockResolvedValue(false);

    const response = await createProjectRoute(
      jsonRequest("POST", { cloudId: project.cloudId, jiraProjectKey: "NEW", name: "New" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  });

  it("returns 409 project_exists when the project is already set up", async () => {
    const { project } = await setup();
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);

    const response = await createProjectRoute(
      jsonRequest("POST", { cloudId: project.cloudId, jiraProjectKey: "pay", name: "Again" }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("project_exists");
  });

  it("maps a unique-key violation on insert to the same 409 when the check passed first", async () => {
    const { project } = await setup();
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);
    // The duplicate check reports no project, as if a concurrent create had not committed yet.
    vi.mocked(findProjectByKey).mockResolvedValueOnce(null);

    const response = await createProjectRoute(
      jsonRequest("POST", { cloudId: project.cloudId, jiraProjectKey: "PAY", name: "Race" }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("project_exists");
  });
});

describe("GET /api/providers", () => {
  it("returns only the caller's profiles, with the key masked and never in the response", async () => {
    const { owner, other } = await setup();
    const ownKey = "sk-owner-SECRET-1111";
    const otherKey = "sk-other-SECRET-2222";
    await createProfile(db, owner.id, {
      name: "Owner profile",
      baseUrl: "https://llm.example.com/v1",
      apiKey: ownKey,
      model: "m",
      supportsJsonMode: true,
      contextTokens: 128000,
    });
    await createProfile(db, other.id, {
      name: "Other profile",
      baseUrl: "https://llm.example.com/v1",
      apiKey: otherKey,
      model: "m",
      supportsJsonMode: true,
      contextTokens: 128000,
    });

    const response = await listProviders();
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.providers.map((p: { name: string }) => p.name)).toEqual(["Owner profile"]);
    expect(body.providers[0].apiKeyMasked.endsWith("1111")).toBe(true);
    expect(text).not.toContain(ownKey);
    expect(text).not.toContain(otherKey);
    expect(text).not.toContain("SECRET");
  });
});

describe("provider in project responses", () => {
  afterEach(() => {
    for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) delete process.env[key];
    resetEnvCache();
  });

  it("describes the project's own profile, without its key", async () => {
    const { owner, project } = await setup();
    const profile = await createProfile(db, owner.id, {
      name: "Team GPT",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-profile-SECRET-3333",
      model: "gpt-team",
      supportsJsonMode: true,
      contextTokens: 128000,
    });
    await setProjectProvider(db, project.id, profile.id, owner.id);

    const response = await getProject(new Request("http://localhost/api/projects/x"), ctx({ id: project.id }));
    const text = await response.text();
    expect(JSON.parse(text).provider).toEqual({
      source: "profile",
      name: "Team GPT",
      model: "gpt-team",
      baseUrlHost: "llm.example.com",
    });
    expect(text).not.toContain("SECRET");
  });

  it("describes the server default when the project has no profile", async () => {
    const { project } = await setup();
    process.env.LLM_BASE_URL = "http://localhost:11434/v1";
    process.env.LLM_API_KEY = "sk-env-SECRET-4444";
    process.env.LLM_MODEL = "llama";
    resetEnvCache();

    const response = await getProject(new Request("http://localhost/api/projects/x"), ctx({ id: project.id }));
    expect((await response.json()).provider).toEqual({
      source: "env",
      name: "Environment default",
      model: "llama",
      baseUrlHost: "localhost:11434",
    });
  });

  it("returns provider null when there is neither a profile nor a server default", async () => {
    const { project } = await setup();
    const response = await getProject(new Request("http://localhost/api/projects/x"), ctx({ id: project.id }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect("provider" in body).toBe(true);
    expect(body.provider).toBeNull();
  });

  it("includes the provider in each project of the list", async () => {
    const { owner, project } = await setup();
    const profile = await createProfile(db, owner.id, {
      name: "Team GPT",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-profile-SECRET-5555",
      model: "gpt-team",
      supportsJsonMode: true,
      contextTokens: 128000,
    });
    await setProjectProvider(db, project.id, profile.id, owner.id);
    stubSites([{ id: project.cloudId, name: "One", url: project.siteUrl }]);

    const response = await listProjects();
    const body = await response.json();
    expect(body.projects[0].provider).toEqual({
      source: "profile",
      name: "Team GPT",
      model: "gpt-team",
      baseUrlHost: "llm.example.com",
    });
  });
});
