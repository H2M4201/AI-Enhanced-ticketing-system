import { requireUser } from "@/server/auth/session";
import { handle, readForm, RUN_DOCUMENT_MAX_BYTES, uploadedFile } from "@/server/http";
import { runFor } from "@/server/route-access";

export const runtime = "nodejs";

/** Adds one source document to a run. The file is checked for size before its bytes are read. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { service, run } = await runFor((await params).id, user);
    const form = await readForm(request);
    const file = uploadedFile(form, "file", RUN_DOCUMENT_MAX_BYTES, "20 MB");
    return service.addDocument(run.id, file.name, new Uint8Array(await file.arrayBuffer()));
  }, "runs.documents.add");
}
