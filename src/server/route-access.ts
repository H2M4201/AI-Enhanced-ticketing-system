/** Shared lookups for route handlers: load the resource, check the caller may use it, and build the services. */
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import { JiraHttp } from "@/integrations/jira/client";
import { assertOwner, assertProjectAccess } from "@/server/access";
import { getSites } from "@/server/auth/atlassian";
import { getValidAccessToken, type User } from "@/server/auth/tokens";
import type { Db } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import { runDeps } from "@/server/deps";
import { getProject, type Project } from "@/server/projects";
import { getRun, type Run } from "@/server/runs/repo";
import { RunService } from "@/server/runs/service";

/** The database for this request. */
export async function database(): Promise<Db> {
  return (await runDeps()).db;
}

/** The database and the project, after checking the user can browse the project in Jira. */
export async function projectFor(projectId: string, user: User): Promise<{ db: Db; project: Project }> {
  const { db } = await runDeps();
  const project = await getProject(db, projectId);
  await assertProjectAccess(db, user.id, project);
  return { db, project };
}

/** Like projectFor, but only the project's owner passes. */
export async function ownedProjectFor(projectId: string, user: User): Promise<{ db: Db; project: Project }> {
  const { db } = await runDeps();
  const project = await getProject(db, projectId);
  assertOwner(user, project);
  return { db, project };
}

/** A run with its project's access checked, plus a RunService for this request. */
export async function runFor(runId: string, user: User): Promise<{ service: RunService; run: Run; project: Project }> {
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

/** A project as the API returns it. The provider key and the Jira tokens never leave the server. */
export function projectView(project: Project, owned: boolean) {
  return {
    id: project.id,
    name: project.name,
    cloudId: project.cloudId,
    siteUrl: project.siteUrl,
    jiraProjectKey: project.jiraProjectKey,
    providerProfileId: project.providerProfileId,
    retentionDays: project.retentionDays,
    owned,
  };
}
