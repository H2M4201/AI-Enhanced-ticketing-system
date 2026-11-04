import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { handle, readJson } from "@/server/http";
import { createProfile, listProfiles } from "@/server/providers";
import { database } from "@/server/route-access";

export const runtime = "nodejs";

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const CreateProviderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().refine(isHttpUrl, "must be a valid http or https URL"),
  apiKey: z.string().min(1),
  model: z.string().trim().min(1).max(200),
  supportsJsonMode: z.boolean(),
  contextTokens: z.number().int().positive(),
});

/** The caller's own provider profiles. Keys appear only as their last four characters. */
export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    return { providers: await listProfiles(await database(), user.id) };
  }, "providers.list");
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson(request, CreateProviderSchema);
    return createProfile(await database(), user.id, input);
  }, "providers.create");
}
