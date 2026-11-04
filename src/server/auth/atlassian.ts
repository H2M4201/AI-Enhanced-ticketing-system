/** Atlassian OAuth 2.0 (3LO) endpoints. Every call takes an optional fetchImpl for tests. */
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

export const SCOPES = "read:jira-work write:jira-work read:jira-user read:me offline_access";
export const CALLBACK_PATH = "/api/auth/callback/atlassian";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ME_URL = "https://api.atlassian.com/me";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: Date };

/** Atlassian answered successfully but the body is missing something we need. */
export class AtlassianResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlassianResponseError";
  }
}

/** Atlassian answered with a non-success status. The message carries no response text. */
export class AtlassianApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Atlassian request failed with status ${status}`);
    this.name = "AtlassianApiError";
    this.status = status;
  }
}

function redirectUri(): string {
  return `${getEnv().APP_URL.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

/** The URL the browser is sent to in order to sign in. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: getEnv().ATLASSIAN_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Compares the state from the callback with the one stored in the session, in constant time. */
export function stateMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

function toTokenSet(body: TokenResponse, fallbackRefreshToken?: string): TokenSet {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? fallbackRefreshToken ?? "",
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

async function postToken(payload: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: getEnv().ATLASSIAN_CLIENT_ID,
      client_secret: getEnv().ATLASSIAN_CLIENT_SECRET,
      ...payload,
    }),
  });
  if (!res.ok) throw new AtlassianApiError(res.status);
  return (await res.json()) as TokenResponse;
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCode(code: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const body = await postToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }, fetchImpl);
  if (!body.refresh_token) throw new AtlassianResponseError("Atlassian did not return a refresh token");
  return toTokenSet(body);
}

/** Trades a refresh token for a new access token. Atlassian rotates the refresh token, so the new one is returned too. */
export async function refresh(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const body = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
  return toTokenSet(body, refreshToken);
}

async function getJson<T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!res.ok) throw new AtlassianApiError(res.status);
  return (await res.json()) as T;
}

/** The signed-in Atlassian account. */
export async function getMe(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; name: string; email: string | null }> {
  const body = await getJson<{ account_id: string; name: string; email?: string }>(ME_URL, token, fetchImpl);
  return { accountId: body.account_id, name: body.name, email: body.email ?? null };
}

/** The Jira sites the token can access. */
export async function getSites(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cloudId: string; name: string; url: string }[]> {
  const body = await getJson<{ id: string; name: string; url: string }[]>(RESOURCES_URL, token, fetchImpl);
  return body.map((site) => ({ cloudId: site.id, name: site.name, url: site.url }));
}
