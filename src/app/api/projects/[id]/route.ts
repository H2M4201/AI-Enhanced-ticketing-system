import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { handle, readJson } from "@/server/http";
import { deleteProject, getProject, setProjectProvider, setRetentionDays } from "@/server/projects";
import { ownedProjectFor, projectFor, projectView } from "@/server/route-access";

export const runtime = "nodejs";

const PatchProjectSchema = z.object({
  providerProfileId: z.uuid().nullable().optional(),
  retentionDays: z.number().int().min(1).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { project } = await projectFor((await params).id, user);
    return projectView(project, project.ownerUserId === user.id);
  }, "projects.get");
}

/** Owner only: changes the project's provider profile or its retention. */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson(request, PatchProjectSchema);
    const { db, project } = await ownedProjectFor((await params).id, user);
    if (input.providerProfileId !== undefined) {
      await setProjectProvider(db, project.id, input.providerProfileId, user.id);
    }
    if (input.retentionDays !== undefined) await setRetentionDays(db, project.id, input.retentionDays);
    return projectView(await getProject(db, project.id), true);
  }, "projects.update");
}

/** Owner only. Removes the project with its files and runs. */
export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { db, project } = await ownedProjectFor((await params).id, user);
    await deleteProject(db, project.id);
    return { ok: true };
  }, "projects.delete");
}
