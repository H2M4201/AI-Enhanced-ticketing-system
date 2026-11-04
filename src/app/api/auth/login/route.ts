import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/server/auth/atlassian";
import { getSession, newOauthState } from "@/server/auth/session";

export async function GET() {
  const session = await getSession();
  const state = newOauthState();
  session.oauthState = state;
  await session.save();
  return NextResponse.redirect(buildAuthorizeUrl(state));
}
