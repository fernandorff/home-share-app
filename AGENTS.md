# Agent guide — Home Share

Shared-household expense app: a Rust/Axum server (`server/`) that serves the JSON API and the React web app built
by Vite (`src/`), same-origin. Postgres (Neon), cookie-based auth, money as integer cents.

- **Conventions & invariants:** [CLAUDE.md](CLAUDE.md) — the canonical instruction file.
- **Why the architecture is the way it is** (incl. rejected alternatives): [docs/decisions/](docs/decisions/README.md).
- **Feature specs** (non-trivial changes): [docs/specs/](docs/specs/README.md).

Gates before claiming anything works (the same ones CI runs): `npx tsc --noEmit` · `npm run lint` · `npm run test` ·
`npm run build` · `cargo test --manifest-path server/Cargo.toml`.
