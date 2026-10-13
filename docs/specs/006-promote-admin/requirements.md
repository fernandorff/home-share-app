# Promote admin — Requirements

## Problem

A house can only gain admins at creation time. The only admin can't leave or delete their account
while others remain (409 LAST_ADMIN, "promote someone else first"), but the app offers no way to
promote anyone — a dead end found in round 1 of the UI loop (B10).

## User story

As a house admin, I want to make another member an admin so that the house keeps an admin when I
leave and admin chores can be shared.

## Acceptance criteria (EARS)

1. WHEN an admin sends `PATCH /api/groups/active/members/{publicId}` with `{ "role": "ADMIN" }` for
   an active non-admin member of the active house, THE SYSTEM SHALL make that member an admin and
   respond 200 `{ "ok": true }`.
2. WHEN a non-admin sends that request, THE SYSTEM SHALL respond 403 `NOT_ADMIN` and change no role.
3. WHEN the target is not an active member of the caller's active house (another house's user, an
   ex-member or an unknown id), THE SYSTEM SHALL respond 404 `MEMBER_NOT_FOUND` and change no membership.
4. WHEN the body's `role` is anything other than `"ADMIN"`, THE SYSTEM SHALL respond 400 `INVALID_ROLE`.
5. WHEN a member is promoted, THE SYSTEM SHALL record a `GroupMember` UPDATE revision with the actor,
   the house and `after.role = "ADMIN"`.
6. WHILE the viewer is an admin, THE SYSTEM SHALL offer "Make admin" (with a confirmation) in the ⋯
   menu of every active non-admin member on the House page.
7. WHEN `GET /api/auth/me` responds, THE SYSTEM SHALL include `lastAdmin` per house, true exactly
   when the user is that house's only active admin and other active members remain.
8. WHILE `lastAdmin` is true for the active house, THE SYSTEM SHALL show "make another member an
   admin first" in the leave-house dialog and disable Leave; WHILE it is true for any house, THE
   SYSTEM SHALL name those houses in the delete-account dialog and disable Delete.
9. WHEN someone joins a house with the join code (a first-time join or a rejoin after leaving), THE SYSTEM
   SHALL give them the role MEMBER, UNLESS the house has no active admin, in which case THE SYSTEM SHALL
   make them ADMIN (a kicked admin does not get ADMIN back by rejoining, and a house is never left
   without an admin).

## Out of scope

- Demoting an admin or transferring ownership.
- A Summary (AuditLog) entry for role changes — leave/kick have none either; the Detailed trail has it.
