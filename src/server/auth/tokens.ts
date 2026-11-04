import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { safeLog } from "@/lib/log";
import { AtlassianApiError, refresh, type TokenSet } from "@/server/auth/atlassian";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { NotFoundError, ReauthRequiredError } from "@/server/errors";

export type User = typeof users.$inferSelect;

/** Tokens are refreshed when they expire within this window. */
const REFRESH_WINDOW_MS = 60_000;

export type TokenOptions = { fetchImpl?: typeof fetch; now?: () => Date };

export async function getUserById(db: Db, userId: string): Promise<User> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (!row) throw new NotFoundError("User");
  return row;
}

/**
 * Creates or updates the user for an Atlassian account and stores both tokens encrypted.
 * Returns the user's id.
 */
export async function saveUser(
  db: Db,
  profile: { accountId: string; name: string; email: string | null },
  tokens: TokenSet,
): Promise<string> {
  const tokenColumns = {
    accessTokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: encryptSecret(tokens.refreshToken),
    accessTokenExpiresAt: tokens.expiresAt,
  };
  const [row] = await db
    .insert(users)
    .values({
      atlassianAccountId: profile.accountId,
      displayName: profile.name,
      email: profile.email,
      ...tokenColumns,
    })
    .onConflictDoUpdate({
      target: users.atlassianAccountId,
      set: { displayName: profile.name, email: profile.email, ...tokenColumns },
    })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Returns a usable Jira access token for a user. Refreshes it first when it expires within 60 seconds,
 * and stores the rotated refresh token as well. A rejected refresh means the user must sign in again.
 */
export async function getValidAccessToken(db: Db, userId: string, opts: TokenOptions = {}): Promise<string> {
  const now = opts.now ?? (() => new Date());
  const user = await getUserById(db, userId);

  if (user.accessTokenExpiresAt.getTime() - now().getTime() > REFRESH_WINDOW_MS) {
    return decryptSecret(user.accessTokenEnc);
  }

  let fresh: TokenSet;
  try {
    fresh = await refresh(decryptSecret(user.refreshTokenEnc), opts.fetchImpl);
  } catch (error) {
    if (error instanceof AtlassianApiError && (error.status === 400 || error.status === 401)) {
      safeLog("auth.reauth_required", { userId, httpStatus: error.status });
      throw new ReauthRequiredError();
    }
    throw error;
  }

  await db
    .update(users)
    .set({
      accessTokenEnc: encryptSecret(fresh.accessToken),
      refreshTokenEnc: encryptSecret(fresh.refreshToken),
      accessTokenExpiresAt: fresh.expiresAt,
    })
    .where(eq(users.id, userId));
  safeLog("auth.token_refreshed", { userId });
  return fresh.accessToken;
}
