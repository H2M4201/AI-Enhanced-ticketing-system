import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProjectsList } from "@/components/ProjectsList";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!(await signedInUser())) redirect("/");
  return (
    <AppShell signedIn>
      <ProjectsList />
    </AppShell>
  );
}
