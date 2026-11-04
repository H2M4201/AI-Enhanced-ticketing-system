import { requireUser } from "@/server/auth/session";
import { handle } from "@/server/http";
import { jiraFor, siteFor, database } from "@/server/route-access";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ cloudId: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { cloudId } = await params;
    const db = await database();
    await siteFor(db, user, cloudId);
    return { projects: await jiraFor(db, user.id, cloudId).listProjects() };
  }, "sites.projects");
}
