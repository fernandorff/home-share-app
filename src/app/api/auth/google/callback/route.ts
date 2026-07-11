import { NextRequest, NextResponse } from "next/server";
import {
  googleConfigured,
  exchangeCodeForProfile,
  OAUTH_STATE_COOKIE,
} from "@/lib/google-oauth";
import { authService } from "@/services/auth.service";
import { signSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const loginUrl = new URL("/auth/login", origin);

  try {
    if (!googleConfigured()) {
      loginUrl.searchParams.set("error", "google_unavailable");
      return NextResponse.redirect(loginUrl);
    }

    const params = request.nextUrl.searchParams;
    const code = params.get("code");
    const state = params.get("state");
    const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

    if (params.get("error")) {
      loginUrl.searchParams.set("error", "google_cancelled");
      return NextResponse.redirect(loginUrl);
    }
    if (!code || !state || !cookieState || state !== cookieState) {
      loginUrl.searchParams.set("error", "google_state");
      return NextResponse.redirect(loginUrl);
    }

    const redirectUri = `${origin}/api/auth/google/callback`;
    const profile = await exchangeCodeForProfile(code, redirectUri);
    const user = await authService.findOrCreateGoogleUser(profile);

    const token = await signSession({
      userId: user.id,
      publicId: user.publicId,
      name: user.name,
      sessionVersion: user.sessionVersion,
    });

    const res = NextResponse.redirect(new URL("/", origin));
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  } catch {
    loginUrl.searchParams.set("error", "google_failed");
    return NextResponse.redirect(loginUrl);
  }
}
