import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProviderSettings } from "@/components/ProviderSettings";
import { signedInUser } from "@/server/auth/page-user";

export const dynamic = "force-dynamic";

export default async function ProviderSettingsPage() {
  if (!(await signedInUser())) redirect("/");
  return (
    <AppShell signedIn>
      <ProviderSettings />
    </AppShell>
  );
}
