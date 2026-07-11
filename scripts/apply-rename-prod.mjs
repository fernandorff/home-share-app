// Applies the pt→en rename (rename-db-to-english.sql + .followup.sql) to the database in
// DATABASE_URL (.env.local = prod Neon) inside ONE transaction — the sub-second window for
// running code only opens at COMMIT. Verified offline first by scripts/generate-followup.mjs
// (catalog byte-identical to the @map-free schema). Run once, immediately before deploying
// the schema that drops all @map/@@map.
import { readFileSync } from "node:fs";
import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
console.log("target:", url.replace(/:[^:@/]+@/, ":***@").slice(0, 80));

const sql =
  readFileSync("scripts/rename-db-to-english.sql", "utf8") +
  "\n" +
  readFileSync("scripts/rename-db-to-english.followup.sql", "utf8");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log("✅ rename committed");
  const t = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`
  );
  console.log("tables now:", t.rows.map((r) => r.tablename).join(", "));
} catch (e) {
  await client.query("ROLLBACK");
  console.error("❌ rolled back:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
