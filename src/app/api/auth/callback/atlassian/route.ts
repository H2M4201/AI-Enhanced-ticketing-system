import { type NextRequest, NextResponse } from "next/server";
import { AtlassianApiError, exchangeCode, getMe, stateMatches } from "@/server/auth/atlassian";
import { getSession } from "@/server/auth/session";
import { saveUser } from "@/server/auth/tokens";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/lib/env";
import { safeLog } from "@/lib/log";

function appUrl(path: string, query = ""): URL {
  return new URL(`${path}${query}`, getEnv().APP_URL);
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const expectedState = session.oauthState;
  // The stored state is single-use, whatever the outcome.
  session.oauthState = undefined;

  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");

  if (params.has("error") || !code || !stateMatches(expectedState, state ?? undefined)) {
    await session.save();
    safeLog("auth.callback_rejected");
    return NextResponse.redirect(appUrl("/", "?auth_error=1"));
  }

  try {
    const tokens = await exchangeCode(code);
    const me = await getMe(tokens.accessToken);
    session.userId = await saveUser(await getDb(), me, tokens);
  } catch (error) {
    await session.save();
    safeLog("auth.callback_failed", {
      errorCode: error instanceof Error ? error.name : undefined,
      httpStatus: error instanceof AtlassianApiError ? error.status : undefined,
    });
    return NextResponse.redirect(appUrl("/", "?auth_error=1"));
  }

  await session.save();
  safeLog("auth.signed_in");
  return NextResponse.redirect(appUrl("/projects"));
}
