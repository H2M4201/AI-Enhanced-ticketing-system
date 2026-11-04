import { JiraHttp } from "@/integrations/jira/client";
import { JiraCloudAdapter } from "@/integrations/jira/adapter";
import type { Db } from "@/server/db/client";
import { ForbiddenError } from "@/server/errors";
import type { Project } from "@/server/projects";
import { getValidAccessToken } from "@/server/auth/tokens";

/** How long a browse-permission answer is reused. */
const CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = { allowed: boolean; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export type AccessOptions = { fetchImpl?: typeof fetch; now?: () => Date };

/** Empties the browse-permission cache. Intended for tests. */
export function clearAccessCache(): void {
  cache.clear();
}

/**
 * Whether the user can browse the project in Jira, using the user's own token.
 * Answers, including denials, are cached per user and project for 5 minutes.
 */
export async function canAccessProject(
  db: Db,
  userId: string,
  project: Project,
  opts: AccessOptions = {},
): Promise<boolean> {
  const now = (opts.now ?? (() => new Date()))().getTime();
  const key = `${userId}:${project.id}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.allowed;

  const http = new JiraHttp({
    cloudId: project.cloudId,
    getToken: () => getValidAccessToken(db, userId, { fetchImpl: opts.fetchImpl, now: opts.now }),
    fetchImpl: opts.fetchImpl,
  });
  const allowed = await new JiraCloudAdapter(http).canBrowseProject(project.jiraProjectKey);
  cache.set(key, { allowed, expiresAt: now + CACHE_TTL_MS });
  return allowed;
}

/** Throws ForbiddenError unless the user can browse the project. */
export async function assertProjectAccess(
  db: Db,
  userId: string,
  project: Project,
  opts: AccessOptions = {},
): Promise<void> {
  if (!(await canAccessProject(db, userId, project, opts))) {
    throw new ForbiddenError("You do not have access to this project in Jira");
  }
}

/** Throws ForbiddenError unless the user owns the project. */
export function assertOwner(user: { id: string }, project: Pick<Project, "ownerUserId">): void {
  if (project.ownerUserId !== user.id) {
    throw new ForbiddenError("Only the project owner can do this");
  }
}
