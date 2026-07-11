# Feature specs

One folder per **non-trivial** feature: `NNN-kebab-name/` with `requirements.md` →
`design.md` → `tasks.md` (copy [_TEMPLATE](_TEMPLATE/)). Skip this entirely for one-line
fixes and small tweaks — the ceremony must stay cheaper than the change.

Why three files (and not one): each layer locks one kind of decision — WHAT/WHY
(requirements), HOW (design), STEPS (tasks) — so a mistake is caught at the cheapest
layer and an agent can load only the part it needs.

Rules that make specs work with AI agents:

- **Every acceptance criterion is machine-checkable** (EARS: `WHEN <trigger>, THE SYSTEM
  SHALL <response>`). If you can't verify it in ~10 seconds with a test or a curl, rewrite it.
- **Every task names its file(s) and back-references a requirement** (`_Requirements: 1.2_`).
  Work that traces to no requirement is out of scope by construction.
- Criteria become vitest cases; `npm run test` + CI are what turn the spec into a constraint.
- Specs are disposable: once shipped, the folder stays as history — the tests remain the
  living contract.

## Index

_(none yet)_
