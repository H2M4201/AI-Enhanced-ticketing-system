import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import {
  AtlassianApiError,
  AtlassianResponseError,
  buildAuthorizeUrl,
  exchangeCode,
  getMe,
  getSites,
  refresh,
  stateMatches,
} from "@/server/auth/atlassian";
import { getUserById, getValidAccessToken, saveUser } from "@/server/auth/tokens";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { ReauthRequiredError } from "@/server/errors";
import { testDb } from "../helpers/db";

const NOW = new Date("2026-11-04T10:00:00Z");

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.env.ATLASSIAN_CLIENT_ID = "client-id";
  process.env.ATLASSIAN_CLIENT_SECRET = "client-secret";
  process.env.SESSION_SECRET = "x".repeat(32);
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.APP_URL;
  resetEnvCache();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function insertUser(db: Db, expiresAt: Date) {
  const [row] = await db
    .insert(users)
    .values({
      atlassianAccountId: `acct-${Math.random()}`,
      displayName: "Minh",
      email: null,
      accessTokenEnc: encryptSecret("old-access"),
      refreshTokenEnc: encryptSecret("old-refresh"),
      accessTokenExpiresAt: expiresAt,
    })
    .returning();
  return row;
}

describe("buildAuthorizeUrl", () => {
  it("carries scopes, callback and state", () => {
    const u = new URL(buildAuthorizeUrl("s1"));
    expect(u.origin + u.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(u.searchParams.get("scope")).toBe("read:jira-work write:jira-work read:jira-user read:me offline_access");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback/atlassian");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("client_id")).toBe("client-id");
    expect(u.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });
});

describe("stateMatches", () => {
  it("accepts an identical state", () => {
    expect(stateMatches("abc-DEF_123", "abc-DEF_123")).toBe(true);
  });

  it("rejects a different state of the same length", () => {
    expect(stateMatches("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects a state of a different length", () => {
    expect(stateMatches("abcdef", "abc")).toBe(false);
  });

  it("rejects a missing state on either side", () => {
    expect(stateMatches(undefined, "abc")).toBe(false);
    expect(stateMatches("abc", undefined)).toBe(false);
    expect(stateMatches("", "")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns tokens with an expiry", async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    const tokens = await exchangeCode("auth-code", fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.atlassian.com/oauth/token");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "auth-code" });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt.getTime() - Date.now()).toBeGreaterThan(3500 * 1000);
  });

  it("rejects a response without a refresh token instead of storing an empty one", async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: "at", expires_in: 3600 }));
    const error = await exchangeCode("auth-code", fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlassianResponseError);
  });

  it("throws an error with the status and no response text when Atlassian rejects the code", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant", error_description: "code secret-code" }, 400));
    const error = await exchangeCode("secret-code", fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlassianApiError);
    expect((error as AtlassianApiError).status).toBe(400);
    expect((error as Error).message).not.toContain("secret-code");
  });
});

describe("refresh", () => {
  it("returns the rotated refresh token", async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
    const tokens = await refresh("old-refresh", fetchImpl as unknown as typeof fetch);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
  });
});

describe("getMe and getSites", () => {
  it("maps the profile fields", async () => {
    const fetchImpl = vi.fn(async () => json({ account_id: "acct-1", name: "Minh", email: "m@example.com" }));
    const me = await getMe("token", fetchImpl as unknown as typeof fetch);
    expect(me).toEqual({ accountId: "acct-1", name: "Minh", email: "m@example.com" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.atlassian.com/me");
  });

  it("returns a null email when the profile has none", async () => {
    const fetchImpl = vi.fn(async () => json({ account_id: "acct-1", name: "Minh" }));
    expect((await getMe("token", fetchImpl as unknown as typeof fetch)).email).toBeNull();
  });

  it("lists every accessible site", async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        { id: "cloud-1", name: "One", url: "https://one.atlassian.net", scopes: [] },
        { id: "cloud-2", name: "Two", url: "https://two.atlassian.net", scopes: [] },
      ]),
    );
    const sites = await getSites("token", fetchImpl as unknown as typeof fetch);
    expect(sites).toEqual([
      { cloudId: "cloud-1", name: "One", url: "https://one.atlassian.net" },
      { cloudId: "cloud-2", name: "Two", url: "https://two.atlassian.net" },
    ]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.atlassian.com/oauth/token/accessible-resources",
    );
  });
});

describe("getValidAccessToken", () => {
  it("refreshes a token that expires within 60 seconds and stores both rotated tokens encrypted", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() + 30_000));
    const fetchImpl = vi.fn(async () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));

    const token = await getValidAccessToken(db, user.id, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });

    expect(token).toBe("new-access");
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(decryptSecret(row.accessTokenEnc)).toBe("new-access");
    expect(decryptSecret(row.refreshTokenEnc)).toBe("new-refresh");
    expect(row.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(row.accessTokenEnc).not.toContain("new-access");
  });

  it("does not refresh a token that is valid for 10 minutes", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() + 10 * 60_000));
    const fetchImpl = vi.fn(async () => json({}));

    const token = await getValidAccessToken(db, user.id, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });

    expect(token).toBe("old-access");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([400, 401])("throws ReauthRequiredError when Atlassian rejects the refresh with %i", async (status) => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() - 1000));
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant" }, status));

    await expect(
      getValidAccessToken(db, user.id, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW }),
    ).rejects.toBeInstanceOf(ReauthRequiredError);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(decryptSecret(row.refreshTokenEnc)).toBe("old-refresh");
  });

  it("does not turn a server error into ReauthRequiredError", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() - 1000));
    const fetchImpl = vi.fn(async () => json({}, 503));

    const error = await getValidAccessToken(db, user.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ReauthRequiredError);
    expect(error).toBeInstanceOf(AtlassianApiError);
  });
});

describe("getValidAccessToken concurrency and forced refresh", () => {
  it("shares one in-flight refresh between concurrent callers", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() + 30_000));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW };

    const first = getValidAccessToken(db, user.id, opts);
    const second = getValidAccessToken(db, user.id, opts);
    release();

    expect(await Promise.all([first, second])).toEqual(["new-access", "new-access"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a superseded refresh token when a stale read races a completed refresh", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(Date.now() + 30_000));
    const staleRow = await getUserById(db, user.id);
    const sentRefreshTokens: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentRefreshTokens.push(JSON.parse(String(init.body)).refresh_token);
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    });
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };

    // Caller A refreshes and stores the rotated tokens.
    expect(await getValidAccessToken(db, user.id, opts)).toBe("new-access");

    // Caller B's first read returns the row from before A's refresh.
    let firstRead = true;
    const staleDb = {
      select: (...args: Parameters<Db["select"]>) => {
        if (!firstRead) return db.select(...args);
        firstRead = false;
        return { from: () => ({ where: async () => [staleRow] }) };
      },
      update: (...args: Parameters<Db["update"]>) => db.update(...args),
    } as unknown as Db;

    expect(await getValidAccessToken(staleDb, user.id, opts)).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentRefreshTokens).toEqual(["old-refresh"]);
  });

  it("refreshes a valid token when forceRefresh is set", async () => {
    const db = await testDb();
    const user = await insertUser(db, new Date(NOW.getTime() + 10 * 60_000));
    const fetchImpl = vi.fn(async () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));

    const token = await getValidAccessToken(db, user.id, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      forceRefresh: true,
    });

    expect(token).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("saveUser", () => {
  it("upserts on the Atlassian account id and keeps one row per account", async () => {
    const db = await testDb();
    const tokens = { accessToken: "a1", refreshToken: "r1", expiresAt: NOW };
    const first = await saveUser(db, { accountId: "acct-9", name: "Minh", email: null }, tokens);
    const second = await saveUser(db, { accountId: "acct-9", name: "Minh N", email: "m@example.com" }, {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: NOW,
    });

    expect(second).toBe(first);
    const rows = await db.select().from(users).where(eq(users.atlassianAccountId, "acct-9"));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Minh N");
    expect(decryptSecret(rows[0].accessTokenEnc)).toBe("a2");
    expect(decryptSecret(rows[0].refreshTokenEnc)).toBe("r2");
  });
});
