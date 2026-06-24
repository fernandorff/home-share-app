import { execSync } from "node:child_process";
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

  // Schema DDL straight from the Prisma schema (offline diff — no datasource needed).
  const ddl = execSync(
    "npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script",
    { encoding: "utf8" }
  );
  await db.exec(ddl);

  const server = new PGLiteSocketServer({ db, port: 54329, host: "127.0.0.1" });
  await server.start();

  return async () => {
    await server.stop();
    await db.close();
  };
}
