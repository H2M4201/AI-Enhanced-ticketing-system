import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { providerProfiles, projectFiles, projects } from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/errors";

export type Project = typeof projects.$inferSelect;
export type ProjectFile = typeof projectFiles.$inferSelect;

export type NewProject = {
  name: string;
  cloudId: string;
  siteUrl: string;
  jiraProjectKey: string;
};

export async function createProject(db: Db, ownerUserId: string, input: NewProject): Promise<Project> {
  const [row] = await db.insert(projects).values({ ownerUserId, ...input }).returning();
  return row;
}

export async function getProject(db: Db, id: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  if (!row) throw new NotFoundError("Project");
  return row;
}

/** Projects on the Jira sites a user can access. */
export async function listProjectsForSites(db: Db, cloudIds: string[]): Promise<Project[]> {
  if (cloudIds.length === 0) return [];
  return db.select().from(projects).where(inArray(projects.cloudId, cloudIds));
}

/** Links a provider profile to a project, or unlinks it with null. Only the profile's owner may link it. */
export async function setProjectProvider(
  db: Db,
  projectId: string,
  profileId: string | null,
  actingUserId: string,
): Promise<void> {
  if (profileId !== null) {
    const [profile] = await db
      .select({ ownerUserId: providerProfiles.ownerUserId })
      .from(providerProfiles)
      .where(eq(providerProfiles.id, profileId));
    if (!profile) throw new NotFoundError("Provider profile");
    if (profile.ownerUserId !== actingUserId) {
      throw new ForbiddenError("You can only use a provider profile you own");
    }
  }
  await db.update(projects).set({ providerProfileId: profileId }).where(eq(projects.id, projectId));
}

export async function setRetentionDays(db: Db, projectId: string, days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("Retention must be a whole number of days, at least 1");
  }
  await db.update(projects).set({ retentionDays: days }).where(eq(projects.id, projectId));
}

/**
 * Stores a new version of a guideline or routing file and makes it the active one.
 * The previous active version with the same filename is deactivated. A routing upload
 * deactivates every previous routing file, since a project has one active routing file.
 */
export async function uploadProjectFile(
  db: Db,
  projectId: string,
  uploadedBy: string,
  kind: ProjectFile["kind"],
  filename: string,
  content: string,
): Promise<ProjectFile> {
  if (content.trim() === "") throw new Error(`${filename} is empty`);
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

  return db.transaction(async (tx) => {
    const sameName = and(eq(projectFiles.projectId, projectId), eq(projectFiles.kind, kind), eq(projectFiles.filename, filename));
    const earlier = await tx.select({ version: projectFiles.version }).from(projectFiles).where(sameName);
    const version = earlier.reduce((highest, row) => Math.max(highest, row.version), 0) + 1;

    const supersededScope =
      kind === "routing"
        ? and(eq(projectFiles.projectId, projectId), eq(projectFiles.kind, kind))
        : sameName;
    await tx
      .update(projectFiles)
      .set({ active: false })
      .where(and(supersededScope, eq(projectFiles.active, true)));

    const [row] = await tx
      .insert(projectFiles)
      .values({ projectId, kind, filename, content, sha256, version, active: true, uploadedBy })
      .returning();
    return row;
  });
}

/** Marks a file inactive. Runs that already recorded it keep reading its content. */
export async function removeProjectFile(db: Db, fileId: string): Promise<void> {
  await db.update(projectFiles).set({ active: false }).where(eq(projectFiles.id, fileId));
}

export async function activeFiles(db: Db, projectId: string): Promise<ProjectFile[]> {
  return db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.active, true)));
}

/** Projects a user owns, on any site. */
export async function listOwnedProjects(db: Db, ownerUserId: string): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.ownerUserId, ownerUserId));
}

/** The project already set up for a Jira project key on a site, or null. */
export async function findProjectByKey(db: Db, cloudId: string, jiraProjectKey: string): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.cloudId, cloudId), eq(projects.jiraProjectKey, jiraProjectKey)));
  return row ?? null;
}

/** A file that belongs to the project, including inactive versions. Throws NotFoundError otherwise. */
export async function getProjectFile(db: Db, projectId: string, fileId: string): Promise<ProjectFile> {
  const [row] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.id, fileId), eq(projectFiles.projectId, projectId)));
  if (!row) throw new NotFoundError("File");
  return row;
}

/** Deletes a project. Its files and runs are removed by the database cascade. */
export async function deleteProject(db: Db, projectId: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, projectId));
}
