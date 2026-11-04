import { z } from "zod";
import { activeFiles, uploadProjectFile, type ProjectFile } from "@/server/projects";
import { requireUser } from "@/server/auth/session";
import { HttpError, PROJECT_FILE_MAX_BYTES, handle, readForm, uploadedFile } from "@/server/http";
import { projectFor } from "@/server/route-access";

export const runtime = "nodejs";

const KindSchema = z.enum(["guideline", "routing"]);

function fileView(file: ProjectFile) {
  return {
    id: file.id,
    kind: file.kind,
    filename: file.filename,
    version: file.version,
    uploadedAt: file.createdAt,
  };
}

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { db, project } = await projectFor((await params).id, user);
    return { files: (await activeFiles(db, project.id)).map(fileView) };
  }, "projects.files.list");
}

/** Stores a guideline or routing file as the new active version. Only .md and .txt are accepted. */
export async function POST(request: Request, { params }: Params) {
  return handle(async () => {
    const user = await requireUser();
    const { db, project } = await projectFor((await params).id, user);
    const form = await readForm(request);
    const kind = KindSchema.parse(form.get("kind"));
    const file = uploadedFile(form, "file", PROJECT_FILE_MAX_BYTES, "200 KB");
    if (!/\.(md|txt)$/i.test(file.name)) {
      throw new HttpError(415, "unsupported_type", "Project files must be .md or .txt");
    }
    const content = await file.text();
    if (content.trim() === "") throw new HttpError(422, "empty_file", `${file.name} is empty`);
    const row = await uploadProjectFile(db, project.id, user.id, kind, file.name, content);
    return fileView(row);
  }, "projects.files.upload");
}
