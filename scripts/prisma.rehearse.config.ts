// Throwaway Prisma config for the rename rehearsal/verification: points the datasource at
// whatever REHEARSE_DB_URL says (pglite socket locally; prod Neon during the real run) and
// the schema at the @map-free variant. Used only via `prisma migrate diff --config`.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: process.env.REHEARSE_SCHEMA ?? "schema.english.prisma",
  datasource: {
    url: process.env.REHEARSE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:45432/postgres",
  },
});
