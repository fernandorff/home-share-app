"use client";

/**
 * Sets a non-httpOnly preference cookie (locale/theme) from client JS.
 * `Secure` is added only in production — same condition as the httpOnly session/group cookies
 * in lib/auth.ts. A plain `; Secure` would make the browser silently refuse to set the cookie
 * at all on local http://localhost dev.
 */
export function setClientCookie(name: string, value: string) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax${secure}`;
}
