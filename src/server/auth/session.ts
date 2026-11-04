import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";
import { getEnv } from "@/lib/env";
import { getDb } from "@/server/db/client";
import { NotFoundError, UnauthorizedError } from "@/server/errors";
import { getUserById, type User } from "@/server/auth/tokens";

export type SessionData = {
  userId?: string;
  oauthState?: string;
};

function sessionOptions(): SessionOptions {
  const { SESSION_SECRET, APP_URL } = getEnv();
  return {
    password: SESSION_SECRET,
    cookieName: "ebc_session",
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: APP_URL.startsWith("https://"),
    },
  };
}

/** The signed session cookie for the current request. */
export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

/** A fresh random OAuth state value: 32 bytes, base64url. */
export function newOauthState(): string {
  return randomBytes(32).toString("base64url");
}

/** The signed-in user. Throws UnauthorizedError when there is no session or the user no longer exists. */
export async function requireUser(): Promise<User> {
  const session = await getSession();
  if (!session.userId) throw new UnauthorizedError();
  try {
    return await getUserById(await getDb(), session.userId);
  } catch (error) {
    if (error instanceof NotFoundError) throw new UnauthorizedError();
    throw error;
  }
}
