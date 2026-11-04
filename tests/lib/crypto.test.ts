import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";

beforeEach(() => {
  process.env.ATLASSIAN_CLIENT_ID = "client-id";
  process.env.ATLASSIAN_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  resetEnvCache();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a plaintext value", () => {
    expect(decryptSecret(encryptSecret("sk-abc123"))).toBe("sk-abc123");
  });

  it("produces the v1:iv:tag:ciphertext format without the plaintext", () => {
    const enc = encryptSecret("sk-abc123");
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(enc).not.toContain("sk-abc123");
  });

  it("uses a fresh IV on every call", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects tampered ciphertext", () => {
    const parts = encryptSecret("x").split(":");
    parts[3] = Buffer.from("zzzz").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("maskSecret", () => {
  it("shows only the last 4 characters", () => {
    expect(maskSecret("sk-abcdef1234")).toBe("••••1234");
  });
});
