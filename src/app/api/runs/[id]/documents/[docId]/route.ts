import { requireUser } from "@/server/auth/session";
import { handle } from "@/server/http";
import { assertUuid, runFor } from "@/server/route-access";

export const runtime = "nodejs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id, docId } = await params;
    const { service, run } = await runFor(id, user);
    assertUuid(docId, "Document");
    await service.removeDocument(run.id, docId);
    return { ok: true };
  }, "runs.documents.remove");
}
