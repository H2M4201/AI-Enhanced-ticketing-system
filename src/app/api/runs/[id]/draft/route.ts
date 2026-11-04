import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { handle, readJson } from "@/server/http";
import { DraftOpSchema } from "@/server/runs/ops";
import { runFor } from "@/server/route-access";

export const runtime = "nodejs";

const EditDraftSchema = z.object({
  op: DraftOpSchema,
  expectedVersion: z.number().int().min(0),
});

type Params = { params: Promise<{ id: string }> };

/** The review view: the draft, its version, blockers, the provider and the assignable users. */
export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { service, run } = await runFor((await params).id, user);
    return service.getReview(run.id, user.id);
  }, "runs.draft.get");
}

/** Generates the draft from the inputs and answers, then returns the review view. */
export async function POST(_request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { service, run } = await runFor((await params).id, user);
    await service.generateDraft(user.id, run.id);
    return service.getReview(run.id, user.id);
  }, "runs.draft.generate");
}

/** Applies one edit and returns the new draft state (items, blockers, version, status, assignable users). A stale expectedVersion is a 409. */
export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { service, run } = await runFor((await params).id, user);
    const input = await readJson(request, EditDraftSchema);
    await service.editDraft(user.id, run.id, input.op, input.expectedVersion);
    return service.getDraftState(run.id);
  }, "runs.draft.edit");
}
