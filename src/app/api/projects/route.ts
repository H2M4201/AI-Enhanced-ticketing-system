import { z } from "zod";
import { canAccessProject } from "@/server/access";
import { requireUser } from "@/server/auth/session";
import { ForbiddenError, ReauthRequiredError } from "@/server/errors";
import { HttpError, handle, readJson } from "@/server/http";
import { createProject, findProjectByKey, listOwnedProjects, listProjectsForSites, type Project } from "@/server/projects";
import { database, isUniqueViolation, jiraFor, projectView, siteFor, sitesFor } from "@/server/route-access";
import type { Db } from "@/server/db/client";

export const runtime = "nodejs";

const CreateProjectSchema = z.object({
  cloudId: z.string().min(1),
  jiraProjectKey: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
});

/**
 * Whether the user may see a project they do not own. A failure for one project counts as no access,
 * except a revoked Atlassian grant, which must reach the caller so the user signs in again.
 */
async function canSee(db: Db, userId: string, project: Project): Promise<boolean> {
  try {
    return await canAccessProject(db, userId, project);
  } catch (error) {
    if (error instanceof ReauthRequiredError) throw error;
    return false;
  }
}

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    const db = await database();
    const sites = await sitesFor(db, user);
    const owned = await listOwnedProjects(db, user.id);
    const onSites = await listProjectsForSites(db, sites.map((site) => site.cloudId));

    const ownedIds = new Set(owned.map((project) => project.id));
    const candidates = new Map<string, Project>();
    for (const project of [...owned, ...onSites]) candidates.set(project.id, project);

    const visible = await Promise.all(
      [...candidates.values()].map(async (project) => {
        if (ownedIds.has(project.id)) return project;
        return (await canSee(db, user.id, project)) ? project : null;
      }),
    );
    return {
      projects: visible
        .filter((project): project is Project => project !== null)
        .map((project) => projectView(project, ownedIds.has(project.id))),
    };
  }, "projects.list");
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson(request, CreateProjectSchema);
    const db = await database();
    const key = input.jiraProjectKey.toUpperCase();

    const site = await siteFor(db, user, input.cloudId);
    if (!(await jiraFor(db, user.id, input.cloudId).canBrowseProject(key))) {
      throw new ForbiddenError("You cannot browse that Jira project");
    }
    if (await findProjectByKey(db, input.cloudId, key)) {
      throw new HttpError(409, "project_exists", `${key} is already set up`);
    }

    try {
      const project = await createProject(db, user.id, {
        name: input.name,
        cloudId: input.cloudId,
        siteUrl: site.url,
        jiraProjectKey: key,
      });
      return projectView(project, true);
    } catch (error) {
      // A concurrent create can pass the check above and then hit the unique key. It gets the same answer.
      if (isUniqueViolation(error)) throw new HttpError(409, "project_exists", `${key} is already set up`);
      throw error;
    }
  }, "projects.create");
}
