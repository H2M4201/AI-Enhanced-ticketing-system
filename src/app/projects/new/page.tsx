import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { NewProjectForm } from "@/components/NewProjectForm";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  if (!(await signedInUser())) redirect("/");
  return (
    <AppShell signedIn>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">New project</h1>
        <NewProjectForm />
      </div>
    </AppShell>
  );
}
