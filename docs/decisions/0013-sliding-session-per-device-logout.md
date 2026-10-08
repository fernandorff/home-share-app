# Sliding 30-day session; "Log out" signs out this device only

- Status: accepted
- Date: 2026-10-08
- Refines [0001](0001-httponly-cookie-session-auth.md) (the cookie, the JWT and `sessionVersion` stay) and
  [0011](0011-pwa-web-push.md) (a plain logout no longer deletes every push subscription)

**Decision:** The session cookie lives 30 days after the **last use**: the middleware re-signs it at most once a day.
"Log out" clears this browser's cookies only; "Log out of all devices" (Account › Sessions) and a password change bump
`sessionVersion`, revoking every token at once.

## Context and Problem Statement

The owner had to log in again too often. The token was signed only at login and expired 7 days later however much the
app was used, and every logout bumped `sessionVersion`: signing out on the computer also signed out the phone.

## Decision Drivers

- An active member must not be asked to log in again.
- A forgotten device or a copied cookie must still be revocable at once.
- A logged-out device must stop receiving the house's push notifications.
- Step-up checks ("defining a password needs a recent login") must keep meaning a recent **login**.
- No database read in the middleware (edge, every request).

## Considered Options

1. **Sliding renewal in the middleware + per-device logout + explicit "log out of all devices" (chosen).**
2. Keep logout-everywhere, only lengthen the fixed expiry — fewer logins, but signing out one device still kills the others.
3. A session table with one row per device (logout deletes that row) — exact per-device revocation, but a DB write per
   login and a DB read per request, against 0001's "no read to authenticate".

## Decision Outcome

Option 1.

- `SESSION_MAX_AGE_SECONDS` = 30 days; `renewedSessionToken` re-signs a token older than `SESSION_RENEW_AFTER_SECONDS`
  (1 day) with the same claims. The middleware sets it on authenticated **page** requests only, with the
  `homeshare_group` preference re-set to the same 30 days. Never on `/api/*`: `requireSession` answers a revoked token
  with a cookie delete, which a renewal on the same response would race.
- New claim `authAt` (the login time) — renewals keep it, `iat` moves. The first-password step-up
  (`authService.changePassword`) reads `authAt`. Tokens from before this change carry no `authAt`: their `iat` is used.
- `POST /api/auth/logout` only clears the cookies. The client (`lib/logout`) first deletes this device's push
  subscription (`unsubscribePush`) while the session still authorizes it.
- `POST /api/auth/logout-all` bumps `sessionVersion` (with every push subscription, in the same transaction, as before).

### Consequences

- Good: an active member stays signed in; signing out one device leaves the others alone.
- Good: "log out of all devices" and the password change keep 0001's immediate revocation.
- Bad: a copied cookie stays usable while it is used, until "log out of all devices" or a password change (it was
  bounded at 7 days). Accepted: the cookie is httpOnly + SameSite=Lax, and the explicit revocation is one tap away.
- Bad: the middleware renews a token already revoked by `sessionVersion` (no DB read there); it stays useless: the
  page's first API call gets 401 `SESSION_REVOKED` with the cookie deleted, on a response the middleware never touches.
- Bad: if the push release fails at logout (offline), that device keeps its subscription until the next sign-in on it
  (`syncPush` releases it for another member) or "log out of all devices".

## Confirmation

`src/lib/auth.test.ts` (30 days, renewal window, `authAt`), `src/middleware.test.ts` (renewal on a day-old page request
with the house cookie; none on a fresh or expired token, on `/api/*` or `/api/auth/*`), `src/app/api/auth/logout/route.test.ts`,
`src/app/api/auth/logout-all/route.test.ts`, `src/lib/logout.test.ts`.
