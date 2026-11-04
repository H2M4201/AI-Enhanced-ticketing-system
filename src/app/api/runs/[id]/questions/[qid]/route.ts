import { ResolutionSchema } from "@/core/domain";
import { requireUser } from "@/server/auth/session";
import { handle, readJson } from "@/server/http";
import { runFor } from "@/server/route-access";

export const runtime = "nodejs";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id, qid } = await params;
    const resolution = await readJson(request, ResolutionSchema);
    const { service, run } = await runFor(id, user);
    await service.resolveQuestion(run.id, qid, resolution);
    return { ok: true };
  }, "runs.questions.resolve");
}
