# Promote admin — Design

## Approach

`groupService.promoteToAdmin(groupId, actorUserId, targetPublicId)` re-reads the actor's membership
(must be an active ADMIN of `groupId`) and resolves the target by publicId AND an active membership
in the same `groupId`, so another house's user is indistinguishable from an unknown id (404). The
role write is a single `prisma.groupMember.update`, which the audit extension records as a
`GroupMember` UPDATE revision (ADR 0005). `groupService.lastAdminGroupIds(userId)` reuses the
private `assertCanLeave` per active ADMIN membership, so the warning and the server refusal can
never disagree.

## Data model

None (`GroupMember.role` already exists).

## API contract

- `PATCH /api/groups/active/members/:publicId` body `{ "role": "ADMIN" }` → `200 { ok: true }`.
  Errors: `400` (invalid id), `400 INVALID_ROLE`, `403 NOT_ADMIN`, `404 MEMBER_NOT_FOUND`. The house
  is the active-house cookie validated by `requireActiveGroup`; nothing house-related is read from the body.
- `GET /api/auth/me`: each `user.groups[i]` gains `lastAdmin: boolean`.

## UI

House page: the admin's ⋯ menu on a non-admin member gets "Make admin" above "Remove", with a
confirmation dialog (there is no demotion in the app). Leave-house dialog: warning + Leave disabled
when `activeGroup.lastAdmin`. Account › Delete account dialog: warning naming every house with
`lastAdmin` + Delete disabled. New keys in `Household`, `Account`, `ApiErrors` (4 locales).

## Error handling & edge cases

- Promoting someone who is already an admin is a no-op 200 (idempotent double tap).
- The ⋯ trigger label becomes "Actions for {name}" since the menu has two items.
- After a promotion the client reloads the session and the members, so `lastAdmin` updates.

## Alternatives considered

- Computing "only admin" on the client from the members list — rejected: delete-account spans
  every house and the server already owns the rule (`assertCanLeave`).
- Generic role PATCH with demotion — rejected: not requested; demotion needs its own last-admin rules.
