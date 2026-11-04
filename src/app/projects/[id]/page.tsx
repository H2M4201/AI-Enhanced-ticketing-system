import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProjectDetail } from "@/components/ProjectDetail";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await signedInUser())) redirect("/");
  const { id } = await params;
  return (
    <AppShell signedIn>
      <ProjectDetail projectId={id} />
    </AppShell>
  );
}
