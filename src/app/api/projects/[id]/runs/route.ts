import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { handle, readJson } from "@/server/http";
import { serviceFor, projectFor } from "@/server/route-access";

export const runtime = "nodejs";

/** An epic can be long, but not unbounded. The context budget check handles what fits. */
const CreateRunSchema = z.object({
  epicText: z.string().trim().min(1).max(200_000),
  existingEpicKey: z.string().trim().min(1).max(64).nullable().optional(),
});

/** The project's runs, newest first, so a run can be opened again after the page is left. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { project } = await projectFor((await params).id, user);
    return { runs: await (await serviceFor()).listRuns(project.id) };
  }, "runs.list");
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson(request, CreateRunSchema);
    const { project } = await projectFor((await params).id, user);
    const run = await (await serviceFor()).createRun(user.id, project.id, {
      epicText: input.epicText,
      existingEpicKey: input.existingEpicKey ?? null,
    });
    return { id: run.id, status: run.status };
  }, "runs.create");
}
