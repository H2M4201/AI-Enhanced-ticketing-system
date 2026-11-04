import { encryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { assertOwner, assertProjectAccess, canAccessProject, clearAccessCache } from "@/server/access";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { ForbiddenError, ReauthRequiredError } from "@/server/errors";
import { createProject, type Project } from "@/server/projects";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "../helpers/db";

const NOW = new Date("2026-11-04T10:00:00Z");

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A user with a token that is valid for an hour, so no refresh is needed. */
async function setup(db: Db) {
  const [owner] = await db
    .insert(users)
    .values({
      atlassianAccountId: "owner-acct",
      displayName: "Owner",
      email: null,
      accessTokenEnc: encryptSecret("access"),
      refreshTokenEnc: encryptSecret("refresh"),
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
    })
    .returning();
  const project = await createProject(db, owner.id, {
    name: "Payments",
    cloudId: "cloud-1",
    siteUrl: "https://one.atlassian.net",
    jiraProjectKey: "PAY",
  });
  return { owner, project };
}

describe("canAccessProject", () => {
  it("caches the browse permission for 5 minutes per user and project", async () => {
    const db = await testDb();
    const { owner, project } = await setup(db);
    const browse = vi.spyOn(JiraCloudAdapter.prototype, "canBrowseProject").mockResolvedValue(true);
    const at = (ms: number) => () => new Date(NOW.getTime() + ms);

    expect(await canAccessProject(db, owner.id, project, { now: at(0) })).toBe(true);
    expect(await canAccessProject(db, owner.id, project, { now: at(299_000) })).toBe(true);
    expect(browse).toHaveBeenCalledTimes(1);

    expect(await canAccessProject(db, owner.id, project, { now: at(301_000) })).toBe(true);
    expect(browse).toHaveBeenCalledTimes(2);
    expect(browse).toHaveBeenCalledWith("PAY");
  });

  it("keeps a denial until the cache entry expires", async () => {
    const db = await testDb();
    const { owner, project } = await setup(db);
    const browse = vi.spyOn(JiraCloudAdapter.prototype, "canBrowseProject").mockResolvedValue(false);

    expect(await canAccessProject(db, owner.id, project, { now: () => NOW })).toBe(false);
    expect(await canAccessProject(db, owner.id, project, { now: () => NOW })).toBe(false);
    expect(browse).toHaveBeenCalledTimes(1);
  });

  it("does not cache a ReauthRequiredError", async () => {
    const db = await testDb();
    const { owner, project } = await setup(db);
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    // The token is already expired, so the adapter has to refresh it and the refresh is rejected.
    await db.update(users).set({ accessTokenExpiresAt: new Date(NOW.getTime() - 1000) });

    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW };
    await expect(canAccessProject(db, owner.id, project, opts)).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(canAccessProject(db, owner.id, project, opts)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("assertProjectAccess", () => {
  it("throws ForbiddenError when the user cannot browse the project", async () => {
    const db = await testDb();
    const { owner, project } = await setup(db);
    vi.spyOn(JiraCloudAdapter.prototype, "canBrowseProject").mockResolvedValue(false);

    await expect(assertProjectAccess(db, owner.id, project, { now: () => NOW })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("resolves when the user can browse the project", async () => {
    const db = await testDb();
    const { owner, project } = await setup(db);
    vi.spyOn(JiraCloudAdapter.prototype, "canBrowseProject").mockResolvedValue(true);

    await expect(assertProjectAccess(db, owner.id, project, { now: () => NOW })).resolves.toBeUndefined();
  });
});

describe("assertOwner", () => {
  const project = { ownerUserId: "user-a" } as Project;

  it("accepts the owner", () => {
    expect(() => assertOwner({ id: "user-a" }, project)).not.toThrow();
  });

  it("rejects a non-owner", () => {
    expect(() => assertOwner({ id: "user-b" }, project)).toThrow(ForbiddenError);
  });
});
