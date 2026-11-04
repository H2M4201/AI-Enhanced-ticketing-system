import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateBlockedError } from "@/core/pipeline/create";
import { LlmOutputError } from "@/core/llm/structured";
import { encryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraError } from "@/integrations/jira/client";
import { clearAccessCache } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { runDeps } from "@/server/deps";
import { handle } from "@/server/http";
import { ForbiddenError, NotFoundError, ReauthRequiredError, RunStateError } from "@/server/errors";
import { users } from "@/server/db/schema";
import { createProject } from "@/server/projects";
import { insertRun } from "@/server/runs/repo";
import { testDb } from "../helpers/db";
import type { Db } from "@/server/db/client";

import { GET as getRunDetail } from "@/app/api/runs/[id]/route";
import { POST as postChecks } from "@/app/api/runs/[id]/checks/route";
import { PATCH as patchDraft } from "@/app/api/runs/[id]/draft/route";
import { POST as postProjectFile } from "@/app/api/projects/[id]/files/route";
import { PATCH as patchProject, GET as getProject } from "@/app/api/projects/[id]/route";

vi.mock("@/server/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/deps", () => ({ runDeps: vi.fn() }));

const NOW = new Date("2026-11-04T10:00:00Z");

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
});

describe("route handlers", () => {
  // One in-memory database for the file: each setup adds rows with unique ids instead of a new database.
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
  });

  async function setup() {
    const [owner] = await db
      .insert(users)
      .values({
        atlassianAccountId: `owner-${randomUUID()}`,
        displayName: "Owner",
        email: null,
        accessTokenEnc: encryptSecret("access"),
        refreshTokenEnc: encryptSecret("refresh"),
        accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
      })
      .returning();
    const [other] = await db
      .insert(users)
      .values({
        atlassianAccountId: `other-${randomUUID()}`,
        displayName: "Other",
        email: null,
        accessTokenEnc: encryptSecret("access"),
        refreshTokenEnc: encryptSecret("refresh"),
        accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
      })
      .returning();
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
    return { db, owner, other, project };
  }

  const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

  function jsonRequest(method: string, body: unknown): Request {
    return new Request("http://localhost/api", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 409 run_state when checks are run on a run that is already under review", async () => {
    const { db, owner, project } = await setup();
    const run = await insertRun(db, {
      projectId: project.id,
      createdBy: owner.id,
      epicText: "Epic text",
      existingEpicKey: null,
      fileVersions: [],
      status: "review",
    });

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

  it("returns 413 too_large for a project file over 200 KB, before its bytes are read", async () => {
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

  it("returns 400 for a draft edit whose op is not a known DraftOp", async () => {
    const { db, owner, project } = await setup();
    const run = await insertRun(db, {
      projectId: project.id,
      createdBy: owner.id,
      epicText: "Epic text",
      existingEpicKey: null,
      fileVersions: [],
      status: "review",
    });

    const response = await patchDraft(
      jsonRequest("PATCH", { op: { type: "explode", id: "x" }, expectedVersion: 0 }),
      ctx({ id: run.id }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("returns 403 when a non-owner tries to change a project", async () => {
    const { other, project } = await setup();
    vi.mocked(requireUser).mockResolvedValue(other);

    const response = await patchProject(jsonRequest("PATCH", { retentionDays: 14 }), ctx({ id: project.id }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
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

describe("ForbiddenError mapping", () => {
  it("maps ForbiddenError to 403", async () => {
    const { status } = await errorOf(async () => {
      throw new ForbiddenError("nope");
    });
    expect(status).toBe(403);
  });
});
