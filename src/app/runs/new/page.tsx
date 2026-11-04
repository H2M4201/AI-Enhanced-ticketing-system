import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { NewRunForm } from "@/components/run/NewRunForm";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function NewRunPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  if (!(await signedInUser())) redirect("/");
  const { project } = await searchParams;
  return (
    <AppShell signedIn>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">New breakdown</h1>
        {project ? (
          <NewRunForm projectId={project} />
        ) : (
          <p className="text-sm text-neutral-700">
            Choose a project first. Go to{" "}
            <Link href="/projects" className="font-medium underline">
              Projects
            </Link>
            .
          </p>
        )}
      </div>
    </AppShell>
  );
}
