// Prisma is only the migration tool here (`npm run db:migrate`, CI's migrations-match-schema check); the Rust server
// talks to Postgres directly. A variable already set in the shell or CI wins over `.env.local` / `.env`.
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Only for diffing the migrations folder (CI's migrations-match-schema check, `prisma migrate dev`): an empty,
    // throwaway database Prisma may wipe. Never a real one.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
