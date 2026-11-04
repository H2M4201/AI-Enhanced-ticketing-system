import Link from "next/link";
import type { ReactNode } from "react";
import { card } from "@/components/styles";

/** Page frame: header with navigation and sign-out when signed in, then the page body. */
export function AppShell({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href={signedIn ? "/projects" : "/"} className="font-semibold tracking-tight">
            Epic-to-Backlog Copilot
          </Link>
          {signedIn ? (
            <nav className="flex items-center gap-5 text-sm text-neutral-700">
              <Link href="/projects" className="hover:text-neutral-950">
                Projects
              </Link>
              <Link href="/settings/providers" className="hover:text-neutral-950">
                AI providers
              </Link>
              <form method="post" action="/api/auth/logout">
                <button type="submit" className="hover:text-neutral-950">
                  Sign out
                </button>
              </form>
            </nav>
          ) : null}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className={signedIn ? "" : card}>{children}</div>
      </main>
    </div>
  );
}
