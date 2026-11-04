import { requireUser } from "@/server/auth/session";
import { handle } from "@/server/http";
import { getProjectFile, removeProjectFile } from "@/server/projects";
import { ownedProjectFor } from "@/server/route-access";

export const runtime = "nodejs";

/** Owner only. Marks the file inactive; runs that already used it keep their copy. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id, fileId } = await params;
    const { db, project } = await ownedProjectFor(id, user);
    await getProjectFile(db, project.id, fileId);
    await removeProjectFile(db, fileId);
    return { ok: true };
  }, "projects.files.delete");
}
