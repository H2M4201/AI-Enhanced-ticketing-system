import { requireUser } from "@/server/auth/session";
import { handle } from "@/server/http";
import { sitesFor, database } from "@/server/route-access";

export const runtime = "nodejs";

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    return { sites: await sitesFor(await database(), user) };
  }, "sites.list");
}
