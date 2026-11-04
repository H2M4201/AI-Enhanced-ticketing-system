import { asc, eq } from "drizzle-orm";
import type { ProviderConfig } from "@/core/llm/client";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import type { Db } from "@/server/db/client";
import { providerProfiles } from "@/server/db/schema";
import { NoProviderError } from "@/server/errors";
import type { Project } from "@/server/projects";

export type ProfileInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsJsonMode: boolean;
  contextTokens: number;
};

/** A profile as the UI sees it. The API key never appears here, only its last four characters. */
export type ProfileView = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  supportsJsonMode: boolean;
  contextTokens: number;
  apiKeyMasked: string;
};

export type ProviderDescription = {
  source: "profile" | "env";
  name: string;
  model: string;
  baseUrlHost: string;
};

type ProfileRow = typeof providerProfiles.$inferSelect;

function toView(row: ProfileRow, apiKeyMasked: string): ProfileView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    supportsJsonMode: row.supportsJsonMode,
    contextTokens: row.contextTokens,
    apiKeyMasked,
  };
}

function assertHttpUrl(value: string): void {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error("Base URL must be a valid http or https URL");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("Base URL must be a valid http or https URL");
  }
}

/** Stores a provider profile owned by a user. The API key is encrypted at rest. */
export async function createProfile(db: Db, ownerUserId: string, input: ProfileInput): Promise<ProfileView> {
  assertHttpUrl(input.baseUrl);
  const [row] = await db
    .insert(providerProfiles)
    .values({
      ownerUserId,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKeyEnc: encryptSecret(input.apiKey),
      model: input.model,
      supportsJsonMode: input.supportsJsonMode,
      contextTokens: input.contextTokens,
    })
    .returning();
  return toView(row, maskSecret(input.apiKey));
}

export async function listProfiles(db: Db, ownerUserId: string): Promise<ProfileView[]> {
  const rows = await db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.ownerUserId, ownerUserId))
    .orderBy(asc(providerProfiles.createdAt));
  return rows.map((row) => toView(row, maskSecret(decryptSecret(row.apiKeyEnc))));
}

type Resolved = { source: ProviderDescription["source"]; name: string; config: ProviderConfig };

/**
 * The project's profile when one is set, else the environment default, else NoProviderError.
 * The environment default has JSON mode off, because its capabilities are unknown.
 */
async function resolve(db: Db, project: Project): Promise<Resolved> {
  if (project.providerProfileId !== null) {
    const [row] = await db.select().from(providerProfiles).where(eq(providerProfiles.id, project.providerProfileId));
    if (!row) throw new NoProviderError();
    return {
      source: "profile",
      name: row.name,
      config: {
        baseUrl: row.baseUrl,
        apiKey: decryptSecret(row.apiKeyEnc),
        model: row.model,
        supportsJsonMode: row.supportsJsonMode,
        contextTokens: row.contextTokens,
      },
    };
  }

  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_CONTEXT_TOKENS } = getEnv();
  if (LLM_BASE_URL && LLM_API_KEY && LLM_MODEL) {
    return {
      source: "env",
      name: "Environment default",
      config: {
        baseUrl: LLM_BASE_URL,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL,
        supportsJsonMode: false,
        contextTokens: LLM_CONTEXT_TOKENS,
      },
    };
  }

  throw new NoProviderError();
}

/** The connection settings to use for a project, including the decrypted key. */
export async function resolveProviderConfig(db: Db, project: Project): Promise<ProviderConfig> {
  return (await resolve(db, project)).config;
}

/** The host of a base URL. A value that does not parse is shown as it is, so a bad setting cannot break the review page. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** What the UI shows about the provider in use. It never includes the key. */
export async function describeProvider(db: Db, project: Project): Promise<ProviderDescription> {
  const { source, name, config } = await resolve(db, project);
  return { source, name, model: config.model, baseUrlHost: hostOf(config.baseUrl) };
}
