# Architecture Decision Records

Why the load-bearing choices were made — including the alternatives we rejected, which the
code alone can't tell you. One immutable file per decision, [MADR](https://adr.github.io/madr/) format.

Conventions:

- Numbering: `NNNN-kebab-title.md`, sequential.
- **The rule up front**: a one-sentence `**Decision:**` right under the title, so a
  reader (human or agent) skimming mid-task gets the invariant without reading the file.
- Rejected options carry their one-line rejection reason inline in the options list —
  no separate pros/cons section.
- **Append-only.** A reversed decision gets a *new* ADR; the old one is marked
  `Status: superseded by [NNNN]` — never edited or deleted.
- Each ADR names its **Confirmation**: the executable check (test, helper, middleware) that
  enforces the decision, so it's a constraint, not a comment.

## Index

- [0001 — Session auth via httpOnly cookie, not Bearer tokens](0001-httponly-cookie-session-auth.md)
- [0002 — Active house from a cookie preference; DB membership is the authority](0002-active-house-cookie-db-membership-authority.md)
- [0003 — Money as integer cents](0003-money-as-integer-cents.md)
- [0004 — Next.js same-origin monolith, not a separate frontend + API](0004-nextjs-same-origin-monolith.md)
- [0005 — Audit trail via Prisma extension writing EntityRevision rows](0005-audit-trail-prisma-extension.md)
- [0006 — Optimistic concurrency via expected-state tokens → 409](0006-optimistic-concurrency-expected-state-tokens.md)
