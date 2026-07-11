# Session auth via httpOnly cookie, not Bearer tokens

- Status: accepted
- Date: 2026-07-11 (backfilled — decision predates this record)

**Decision:** the session is a JWT (HS256, `jose`) in the httpOnly cookie `bolitas_session`;
tokens never appear in a response body, and revocation is a `sessionVersion` claim checked
against `User.sessionVersion` on every request.

## Context and Problem Statement

The app is a Next.js monolith: frontend and API in the same app, same-origin. Users stay
logged in across visits, and a session must be revocable immediately (logout, password
change). Where does the session token live, and how does the client send it?

## Decision Drivers

- An XSS bug must not be able to exfiltrate the session token.
- There is no cross-origin API consumer — the only client is the app's own frontend.
- Logout / password change must kill existing sessions immediately, not at token expiry.
- Small surface: no auth framework unless it earns its weight.

## Considered Options

1. **JWT in an httpOnly cookie** — ✅ chosen.
2. Bearer JWT in `localStorage` + `Authorization` header — ❌ any XSS reads
   `localStorage` and steals the session; decisive.
3. Server-side sessions (session table, opaque cookie id) — ❌ a DB read per request just
   to authenticate; the `sessionVersion` claim gives the same revocation with none of the reads.
4. Auth.js / NextAuth — ❌ heavy abstraction for one credential flow + one OAuth provider;
   obscures the exact cookie/session semantics this app depends on.

## Decision Outcome

Auth endpoints set the cookie and return only `{ user }` ([src/lib/auth.ts](../../src/lib/auth.ts)).
Google OAuth reuses `signSession` and the same cookie. Bumping `User.sessionVersion`
invalidates every outstanding token without a session table.

### Consequences

- Good: JS can never read the token, so XSS can't steal a session.
- Good: same-origin + cookie = zero CORS code, no token plumbing (`lib/api` just sends cookies).
- Good: stateless verification, yet instantly revocable via one column.
- Bad: cookies expose a CSRF surface — mitigated by `SameSite` and same-origin-only usage.
- Bad: non-browser clients (CLI, mobile) would need a new auth path; acceptable until one exists.

### Confirmation

- [src/middleware.ts](../../src/middleware.ts) gates every page/API route by the cookie.
- `requireSession()` in [src/lib/api-helpers.ts](../../src/lib/api-helpers.ts) enforces the
  `sessionVersion` comparison; auth route tests cover login/logout/revocation.
