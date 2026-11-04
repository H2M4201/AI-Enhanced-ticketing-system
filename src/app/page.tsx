import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { errorText, primaryButton } from "@/components/styles";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ auth_error?: string }> }) {
  if (await signedInUser()) redirect("/projects");
  const { auth_error } = await searchParams;

  return (
    <AppShell signedIn={false}>
      <div className="mx-auto flex max-w-md flex-col gap-5 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Epic-to-Backlog Copilot</h1>
        <p className="text-neutral-600">
          Turn requirement documents into Jira backlog tickets. You review every draft before anything is created in Jira.
        </p>
        {auth_error === "1" ? (
          <p role="alert" className={errorText}>
            Sign-in didn&apos;t complete. Try again.
          </p>
        ) : null}
        <div>
          <a href="/api/auth/login" className={primaryButton}>
            Sign in with Atlassian
          </a>
        </div>
      </div>
    </AppShell>
  );
}
