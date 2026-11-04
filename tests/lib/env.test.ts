import { beforeEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "@/lib/env";

const REQUIRED: Record<string, string> = {
  ATLASSIAN_CLIENT_ID: "client-id",
  ATLASSIAN_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

beforeEach(() => {
  for (const key of [
    "ATLASSIAN_CLIENT_ID",
    "ATLASSIAN_CLIENT_SECRET",
    "APP_URL",
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "DATABASE_URL",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_CONTEXT_TOKENS",
    "RETENTION_DAYS",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, REQUIRED);
  resetEnvCache();
});

describe("getEnv", () => {
  it("applies defaults for optional values", () => {
    const env = getEnv();
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.RETENTION_DAYS).toBe(7);
    expect(env.LLM_CONTEXT_TOKENS).toBe(128000);
  });

  it("reports missing variable names without their values", () => {
    delete process.env.SESSION_SECRET;
    resetEnvCache();
    expect(() => getEnv()).toThrow(/SESSION_SECRET/);
    expect(() => getEnv()).not.toThrow(/client-secret/);
  });

  it("rejects an ENCRYPTION_KEY that is not 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    resetEnvCache();
    expect(() => getEnv()).toThrow(/ENCRYPTION_KEY/);
  });

  it("caches the parsed result until reset", () => {
    const first = getEnv();
    process.env.RETENTION_DAYS = "30";
    expect(getEnv()).toBe(first);
    resetEnvCache();
    expect(getEnv().RETENTION_DAYS).toBe(30);
  });
});
