import type { ProfileView } from "@/lib/api";

/** What the UI shows about an AI provider. It never carries the key. */
export type ProviderInfo = {
  source: "profile" | "env";
  name: string;
  model: string;
  baseUrlHost: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A host with its port removed, for example "localhost:11434" becomes "localhost". */
function hostname(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

/** Local providers keep documents on this machine. Any other host is an external service. */
export function isCloudHost(host: string): boolean {
  return !LOCAL_HOSTS.has(hostname(host).toLowerCase());
}

export function ProviderBadge({ provider }: { provider: ProviderInfo }) {
  const cloud = isCloudHost(provider.baseUrlHost);
  const name = provider.source === "env" ? "Server default" : provider.name;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm text-neutral-700">
      <span>{`${name} · ${provider.model} (${provider.baseUrlHost})`}</span>
      {cloud ? (
        <span
          title="Documents are sent to an external service. Do not use this provider for confidential material unless your organisation allows it."
          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900"
        >
          cloud
        </span>
      ) : null}
    </span>
  );
}

/** The badge input for a profile the caller owns. */
export function providerFromProfile(profile: Pick<ProfileView, "name" | "model" | "baseUrl">): ProviderInfo {
  let host = profile.baseUrl;
  try {
    host = new URL(profile.baseUrl).host;
  } catch {
    // Shown as stored, so a bad URL cannot break the page.
  }
  return { source: "profile", name: profile.name, model: profile.model, baseUrlHost: host };
}

/** The provider in use, or a notice when none is configured. A project without one cannot start a breakdown. */
export function ProviderOrNone({ provider }: { provider: ProviderInfo | null }) {
  if (!provider) {
    return <span className="text-sm font-medium text-red-700">No provider configured. A breakdown can&apos;t start.</span>;
  }
  return <ProviderBadge provider={provider} />;
}
