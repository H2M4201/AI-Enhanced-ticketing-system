import { requireUser } from "@/server/auth/session";
import type { User } from "@/server/auth/tokens";
import { UnauthorizedError } from "@/server/errors";

/** The signed-in user for a server component, or null when there is no session. Pages redirect on null. */
export async function signedInUser(): Promise<User | null> {
  try {
    return await requireUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}
