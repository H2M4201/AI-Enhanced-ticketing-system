import { requireUser } from "@/server/auth/session";
import { handle } from "@/server/http";
import { runFor } from "@/server/route-access";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { service, run } = await runFor((await params).id, user);
    return service.createTickets(user.id, run.id);
  }, "runs.create-tickets");
}
