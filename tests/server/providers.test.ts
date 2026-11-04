import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import { createProfile, describeProvider, listProfiles, resolveProviderConfig } from "@/server/providers";
import { createProject, getProject, setProjectProvider, type Project } from "@/server/projects";
import { NoProviderError } from "@/server/errors";
import { users } from "@/server/db/schema";
import { testDb } from "../helpers/db";

const API_KEY = "sk-live-test-abcd1234";

beforeEach(() => {
  for (const key of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_CONTEXT_TOKENS", "DATABASE_URL"]) {
    delete process.env[key];
  }
  process.env.ATLASSIAN_CLIENT_ID = "client-id";
  process.env.ATLASSIAN_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  resetEnvCache();
});

async function seed() {
  const db = await testDb();
  const [user] = await db
    .insert(users)
    .values({
      atlassianAccountId: "acc-owner",
      displayName: "Owner",
      accessTokenEnc: "x",
      refreshTokenEnc: "y",
      accessTokenExpiresAt: new Date(),
    })
    .returning();
  const project = await createProject(db, user.id, {
    name: "Checkout",
    cloudId: "cloud-1",
    siteUrl: "https://example.atlassian.net",
    jiraProjectKey: "CHK",
  });
  return { db, user, project };
}

const profileInput = {
  name: "Gateway",
  baseUrl: "https://llm.example.com/v1",
  apiKey: API_KEY,
  model: "model-x",
  supportsJsonMode: true,
  contextTokens: 64000,
};

describe("provider profiles", () => {
  it("never returns the api key and shows only its last four characters", async () => {
    const { db, user } = await seed();
    const created = await createProfile(db, user.id, profileInput);

    expect(JSON.stringify(created)).not.toContain(API_KEY);
    expect(created.apiKeyMasked).toBe("••••1234");
    expect(created).not.toHaveProperty("apiKey");

    const [listed] = await listProfiles(db, user.id);
    expect(JSON.stringify(listed)).not.toContain(API_KEY);
    expect(listed.apiKeyMasked).toBe("••••1234");
  });

  it("stores the key encrypted and resolves the project's profile with the decrypted key", async () => {
    const { db, user, project } = await seed();
    const created = await createProfile(db, user.id, profileInput);
    await setProjectProvider(db, project.id, created.id);

    const config = await resolveProviderConfig(db, await getProject(db, project.id));
    expect(config).toEqual({
      baseUrl: "https://llm.example.com/v1",
      apiKey: API_KEY,
      model: "model-x",
      supportsJsonMode: true,
      contextTokens: 64000,
    });
    const profileRow = (await db.query.providerProfiles.findFirst())!;
    expect(profileRow.apiKeyEnc).not.toContain(API_KEY);
    expect(decryptSecret(profileRow.apiKeyEnc)).toBe(API_KEY);
  });

  it("falls back to the environment default when the project has no profile", async () => {
    const { db, project } = await seed();
    process.env.LLM_BASE_URL = "https://env.example.com/v1";
    process.env.LLM_API_KEY = "env-key";
    process.env.LLM_MODEL = "env-model";
    process.env.LLM_CONTEXT_TOKENS = "32000";
    resetEnvCache();

    expect(await resolveProviderConfig(db, project)).toEqual({
      baseUrl: "https://env.example.com/v1",
      apiKey: "env-key",
      model: "env-model",
      supportsJsonMode: false,
      contextTokens: 32000,
    });
    expect(await describeProvider(db, project)).toEqual({
      source: "env",
      name: "Environment default",
      model: "env-model",
      baseUrlHost: "env.example.com",
    });
  });

  it("describes a project profile without revealing its key", async () => {
    const { db, user, project } = await seed();
    const created = await createProfile(db, user.id, profileInput);
    const linked: Project = { ...project, providerProfileId: created.id };

    const description = await describeProvider(db, linked);
    expect(description).toEqual({ source: "profile", name: "Gateway", model: "model-x", baseUrlHost: "llm.example.com" });
    expect(JSON.stringify(description)).not.toContain(API_KEY);
  });

  it("throws NoProviderError when nothing is configured", async () => {
    const { db, project } = await seed();
    await expect(resolveProviderConfig(db, project)).rejects.toBeInstanceOf(NoProviderError);
    await expect(describeProvider(db, project)).rejects.toBeInstanceOf(NoProviderError);
  });

  it("rejects a base URL that is not http or https", async () => {
    const { db, user } = await seed();
    await expect(createProfile(db, user.id, { ...profileInput, baseUrl: "ftp://llm.example.com" })).rejects.toThrow(
      "Base URL",
    );
  });
});
