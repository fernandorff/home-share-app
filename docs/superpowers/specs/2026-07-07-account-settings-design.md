# Account settings (Minha conta) — design

## Goal

Let a user edit their own personal account data — name, e-mail, username, password — from a
new `/conta` page, reached via a "Minha conta" item in the existing user menu (`UserMenu` in
`AppChrome.tsx`).

## Scope

- Editable fields: `name`, `email`, `username`, `password`.
- Google-only accounts (no password yet) can **define** a password from this screen — it becomes
  an additional way to log in, alongside Google.
- Changing `email` or `username` requires the **current password** as confirmation, when the user
  already has one. Changing `name` alone does not.
- Changing the password (when one already exists) also requires the current password.
- Out of scope (not requested, YAGNI): avatar/photo, account deletion, e-mail verification/confirmation
  links (app has no outbound e-mail sending today), 2FA, session/device management, undoing the
  Google link.

## Data model

No schema change. `User` already has `name`, `username`, `email`, `password`, `googleId`
(pre-existing in `prisma/schema.prisma`). `email` and `username` are already `@unique`.

## API

### `PATCH /api/auth/me`

Body: `{ name?, email?, username?, currentPassword? }` — any subset of the three fields.

- 400 `NO_FIELDS` — none of name/email/username present.
- 400 `INVALID_NAME` — name empty or > 80 chars (same limit `register` already enforces inline).
- 400 `INVALID_EMAIL` — fails a simple `local@domain.tld` regex or > 254 chars. New
  `authService.validateEmail()`, mirroring the existing `validateUsername`/`validatePassword`.
- 400 `INVALID_USERNAME` — reuses `authService.validateUsername` (existing).
- 401 `CURRENT_PASSWORD_REQUIRED` — email or username present **and actually different from the
  stored value** (compared server-side against the DB row, not just "present in the body" — so a
  client that always submits the full form, unchanged fields included, never gets asked for a
  password it doesn't need to give), user already has a password, but `currentPassword`
  missing/empty.
- 401 `CURRENT_PASSWORD_INVALID` — `currentPassword` present but doesn't match.
- Emptying `email`/`username` is not supported: an empty string fails their format validators
  (`INVALID_EMAIL`/`INVALID_USERNAME`) same as any other malformed value, so this endpoint can
  never null out either field.
- 409 `EMAIL_TAKEN` / `USERNAME_TAKEN` — unique constraint conflict (Prisma `P2002`, target field
  tells which one; `USERNAME_TAKEN` code already exists in i18n from `register`).
- 200 → updated `{ user }` (same shape `getUserWithGroups` already returns, minus groups —
  frontend calls `refresh()` from `useSession()` afterwards to get the full `Me` object instead of
  trusting this response body).

Status-code convention follows existing routes: 400 for format validation (matches
`validateExpenseInput`), 401 for wrong/missing credential (matches `login`'s `INVALID_CREDENTIALS`/
`USE_GOOGLE`), 409 for uniqueness conflicts (matches `register`'s `USERNAME_TAKEN`).

New `AuthService.updateProfile(userId, { name?, email?, username?, currentPassword? })`:
reads the user, determines `changingSensitive = (email !== undefined && email !== user.email) ||
(username !== undefined && username !== user.username)`, checks current-password only when
`changingSensitive && user.password !== null`, builds a partial `data` object, does the
`prisma.user.update`, and catches `P2002` to map to `EMAIL_TAKEN`/`USERNAME_TAKEN`. Returns
`{ error, code }` or `{ user }` (typed union, same style as `LoginResult`).

### `POST /api/auth/password`

Body: `{ currentPassword?, newPassword }`.

- 400 `INVALID_PASSWORD` — `newPassword` fails `authService.validatePassword` (existing).
- 401 `CURRENT_PASSWORD_REQUIRED` — user already has a password and `currentPassword` missing/empty.
- 401 `CURRENT_PASSWORD_INVALID` — doesn't match.
- 200 → `{ ok: true }`.

New `AuthService.changePassword(userId, currentPassword | undefined, newPassword)`: if
`user.password !== null`, verifies `currentPassword` first (same 401 codes as above); if the user
is Google-only (`password === null`), skips that check entirely — this is the "define a password"
path. Always ends with `hashPassword` + `prisma.user.update`.

### Rate limiting

Both routes sit behind `requireSession()` (a valid cookie is already required), which bounds
exposure compared to the public `login`/`register` routes. Still, a stolen/shared session should
not let someone brute-force the current password to hijack the account (same class of concern as
the earlier `set-password` takeover fix). Add ``rateLimit(`account:pw:${userId}`, 10, 60_000)``
(existing `lib/rate-limit` helper, now keyed by the authenticated `userId` instead of IP) before
verifying `currentPassword` — same bucket/key shared by both routes (either one draws down the
same budget, since both gate on the same secret) → 429 `RATE_LIMITED` (existing code/i18n) if
exceeded.

### `GET /api/auth/me` (existing route, extended)

`authService.getUserWithGroups` currently selects `id, publicId, name, username` + memberships.
Add `email: true` and derive `hasPassword: boolean` from the (never-returned) `password` field, so
the new page knows whether to show "change password" or "set a password" — the hash itself is
never sent to the client. `Me.user` type in `lib/types.ts` gains `email: string | null` and
`hasPassword: boolean`.

## UI

### `src/app/(app)/conta/page.tsx` (new)

Not in the bottom/side nav (already 6 items) — reached only via the user menu, same pattern as
`/casa`. Two `Card` + `SectionTitle` blocks, matching `/casa`'s visual structure:

1. **Dados pessoais** — `name`, `email`, `username` inputs, prefilled from `useSession().me`. A
   "Senha atual" field appears (and becomes required) only once the user edits `email` or
   `username` away from its original value, and only if `me.user.hasPassword`. One "Salvar" button,
   disabled while unchanged. On success: toast + `useSession().refresh()`.
2. **Senha** — if `hasPassword` is false: "Defina uma senha" with just new + confirm password
   fields (mirrors `set-password` page's fields). If true: "Senha atual" + new + confirm. Client
   checks new === confirm before submitting (same pattern as `set-password`). On success: toast,
   clear fields, and if this was a first-time "define password", refetch `me` (`hasPassword`
   flips true).

### `UserMenu` (`AppChrome.tsx`, existing component)

Add a `MenuItem` "Minha conta" → `router.push("/conta")`, placed above the existing "Casa e
membros" item (personal before household, matches menu order: `@username` label → account →
house → logout).

## i18n

New `Account` namespace (title, section labels, field labels/placeholders, `defineTitle` vs
`changeTitle` for the password block, success/error toasts) in all 4 locales. New `ApiErrors` keys:
`INVALID_EMAIL`, `EMAIL_TAKEN`, `CURRENT_PASSWORD_REQUIRED`, `CURRENT_PASSWORD_INVALID`. Existing
keys reused as-is: `INVALID_NAME`, `INVALID_USERNAME`, `INVALID_PASSWORD`, `USERNAME_TAKEN`,
`RATE_LIMITED`.

## Testing

- Unit: `authService.validateEmail` (format edge cases), `updateProfile` (name-only skips password
  check; email/username change requires+verifies current password; Google-only user with no
  password bypasses the check; `P2002` maps to the right code), `changePassword` (same
  has-password branching; hash actually changes).
- Route-level: reuse the existing `tenant-isolation`/`api-helpers` test style — a user can't be
  impersonated (route always uses `session.userId` from the cookie, never a body field, matching
  the `groupId`-never-from-body rule already in place for groups).
- Manual/e2e: change name only (no password prompt) → reflects immediately (no re-login needed,
  confirmed the JWT never carries a display name read back anywhere); change email with wrong
  current password → 401 + toast; define a password on a Google-only account, then log out and log
  in with username+password.
