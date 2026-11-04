import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getSession } from "@/server/auth/session";

/** POST only, so a cross-site link cannot sign the user out. */
export async function POST() {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/", getEnv().APP_URL), { status: 303 });
}
