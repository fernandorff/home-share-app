import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// Vitest globalSetup: boot an in-process Postgres (pglite) exposed over a TCP socket so the
// app's real Prisma client (adapter-pg → pg Pool → this socket) can run integration tests
// against a genuine database — no Docker, no network, no touching the dev/prod Neon DB.
// DATABASE_URL is pinned in vitest.config (test.env) to this socket. Unit tests that mock
// @/lib/prisma never hit it; only the integration tests do.
export default async function setup() {
  const db = new PGlite();
  await db.waitReady;

  // The real migrations, in order: they carry what schema.prisma cannot (the precomputed-balance triggers,
  // spec 013), and CI already proves they reproduce the schema.
  const dir = "prisma/migrations";
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const name of migrations) await db.exec(readFileSync(join(dir, name, "migration.sql"), "utf8"));

  // Port must match vitest.config.ts's test.env.DATABASE_URL.
  const server = new PGLiteSocketServer({ db, port: 45432, host: "127.0.0.1" });
  await server.start();

  return async () => {
    await server.stop();
    await db.close();
  };
}
