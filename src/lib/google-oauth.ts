// Minimal Google OAuth 2.0 (Authorization Code) helper — no external SDK.
// Guarded by env: when GOOGLE_CLIENT_ID/SECRET are absent, the feature is off.

export const OAUTH_STATE_COOKIE = "homeshare_oauth_state";

export interface GoogleProfile {
  googleId: string;
  email?: string;
  name?: string;
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID as string,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForProfile(
  code: string,
  redirectUri: string
): Promise<GoogleProfile> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error("Falha ao trocar o código do Google");

  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("Google não retornou access_token");

  const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) throw new Error("Falha ao obter o perfil do Google");

  const info = (await infoRes.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string };
  // Only trust the email for account-linking when Google says it's verified — otherwise
  // a Google account with an unverified email could be pointed at someone else's address.
  return { googleId: info.sub, email: info.email_verified ? info.email : undefined, name: info.name };
}
