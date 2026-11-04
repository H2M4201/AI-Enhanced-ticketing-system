import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { RunFlow } from "@/components/run/RunFlow";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await signedInUser())) redirect("/");
  const { id } = await params;
  return (
    <AppShell signedIn>
      <RunFlow runId={id} />
    </AppShell>
  );
}
