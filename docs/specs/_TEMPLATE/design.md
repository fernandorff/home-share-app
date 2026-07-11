# <Feature name> — Design

## Approach

<How it works, in a paragraph. Which existing patterns it follows (services layer, cookie
auth, integer cents — see docs/decisions/ before deviating from any of those).>

## Data model

<Prisma schema changes, or "none". Remember: money is Decimal(10,2) + integer cents in code.>

## API contract

<New/changed endpoints: method, path, request/response shapes, error codes (ApiErrors
namespace) and statuses. groupId never comes from the body.>

## UI

<Screens/components touched; i18n keys to add (all 4 locales); mobile behavior.>

## Error handling & edge cases

<What fails, with which code/status; concurrency concerns (expected-state tokens?).>

## Alternatives considered

- <option> — rejected: <one line>
