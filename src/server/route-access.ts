/** Shared lookups for route handlers: load the resource, check the caller may use it, and build the services. */
import { z } from "zod";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraHttp } from "@/integrations/jira/client";
import { assertOwner, assertProjectAccess } from "@/server/access";
import { getSites } from "@/server/auth/atlassian";
import { getValidAccessToken, type User } from "@/server/auth/tokens";
import type { Db } from "@/server/db/client";
import { ForbiddenError, NoProviderError, NotFoundError } from "@/server/errors";
import { runDeps } from "@/server/deps";
import { getProject, type Project } from "@/server/projects";
import { describeProvider, type ProviderDescription } from "@/server/providers";
import { getRun, type Run } from "@/server/runs/repo";
import { RunService } from "@/server/runs/service";

/** Ids in the path are uuids. Anything else cannot name a row, so it is reported as not found, not as a server error. */
export function assertUuid(value: string, what: string): void {
  if (!z.uuid().safeParse(value).success) throw new NotFoundError(what);
}

/** Whether a database error is a unique-key violation (Postgres code 23505), possibly wrapped by the driver. */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** The database for this request. */
export async function database(): Promise<Db> {
  return (await runDeps()).db;
}

/** The database and the project, after checking the user can browse the project in Jira. */
export async function projectFor(projectId: string, user: User): Promise<{ db: Db; project: Project }> {
  assertUuid(projectId, "Project");
  const { db } = await runDeps();
  const project = await getProject(db, projectId);
  await assertProjectAccess(db, user.id, project);
  return { db, project };
}

/** Like projectFor, but only the project's owner passes. */
export async function ownedProjectFor(projectId: string, user: User): Promise<{ db: Db; project: Project }> {
  assertUuid(projectId, "Project");
  const { db } = await runDeps();
  const project = await getProject(db, projectId);
  assertOwner(user, project);
  return { db, project };
}

/** A run with its project's access checked, plus a RunService for this request. */
export async function runFor(runId: string, user: User): Promise<{ service: RunService; run: Run; project: Project }> {
  assertUuid(runId, "Run");
  const deps = await runDeps();
  const run = await getRun(deps.db, runId);
  const project = await getProject(deps.db, run.projectId);
  await assertProjectAccess(deps.db, user.id, project);
  return { service: new RunService(deps), run, project };
}

/** The Jira sites the user can reach. The app stores none of them, so each call asks Atlassian. */
export async function sitesFor(db: Db, user: User) {
  return getSites(await getValidAccessToken(db, user.id));
}

/** A site the user can reach, or ForbiddenError. */
export async function siteFor(db: Db, user: User, cloudId: string) {
  const site = (await sitesFor(db, user)).find((s) => s.cloudId === cloudId);
  if (!site) throw new ForbiddenError("That Jira site is not available to you");
  return site;
}

/** Jira calls made with the user's own token, for one site. */
export function jiraFor(db: Db, userId: string, cloudId: string): JiraCloudAdapter {
  return new JiraCloudAdapter(
    new JiraHttp({
      cloudId,
      getToken: (opts) => getValidAccessToken(db, userId, { forceRefresh: opts?.forceRefresh }),
    }),
  );
}

/** A new service for this request, with the production wiring. */
export async function serviceFor(): Promise<RunService> {
  return new RunService(await runDeps());
}

/**
 * The provider a project would use, or null when none is configured (no profile and no server default).
 * Only the description is returned: source, name, model and host. The key never leaves the server.
 */
export async function providerOrNull(db: Db, project: Project): Promise<ProviderDescription | null> {
  try {
    return await describeProvider(db, project);
  } catch (error) {
    if (error instanceof NoProviderError) return null;
    throw error;
  }
}

/** A project as the API returns it. The provider key and the Jira tokens never leave the server. */
export function projectView(project: Project, owned: boolean, provider: ProviderDescription | null) {
  return {
    id: project.id,
    name: project.name,
    cloudId: project.cloudId,
    siteUrl: project.siteUrl,
    jiraProjectKey: project.jiraProjectKey,
    providerProfileId: project.providerProfileId,
    retentionDays: project.retentionDays,
    owned,
    provider,
  };
}
