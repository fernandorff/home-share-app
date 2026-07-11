import { NextRequest, NextResponse } from "next/server";
import { googleConfigured, googleAuthUrl, OAUTH_STATE_COOKIE } from "@/lib/google-oauth";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;

  // Guarded: until the env credentials exist, bounce back with a friendly note.
  if (!googleConfigured()) {
    const loginUrl = new URL("/auth/login", origin);
    loginUrl.searchParams.set("error", "google_unavailable");
    return NextResponse.redirect(loginUrl);
  }

  const redirectUri = `${origin}/api/auth/google/callback`;
  const state = crypto.randomUUID();

  const res = NextResponse.redirect(googleAuthUrl(redirectUri, state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
