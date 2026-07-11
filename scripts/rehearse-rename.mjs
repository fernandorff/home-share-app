// Offline rehearsal of the pt→en DB rename (no Docker, no network, never touches Neon):
//   DB-A = current (Portuguese) schema DDL + scripts/rename-db-to-english.sql
//   DB-B = the new @map-free schema DDL applied fresh
// Then diff the catalogs (tables, columns, indexes, constraints, sequences). Whatever differs
// is the follow-up SQL needed so prod ends up byte-identical to what `prisma db push` expects.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const NEW_SCHEMA = process.argv[2] ?? "scripts/schema.english.prisma";

const CATALOG_SQL = `
  SELECT 'table' AS kind, tablename AS name, '' AS detail
    FROM pg_tables WHERE schemaname = 'public'
  UNION ALL
  SELECT 'column', table_name || '.' || column_name, data_type
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT 'index', indexname, indexdef
    FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT 'constraint', rel.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace WHERE nsp.nspname = 'public'
  UNION ALL
  SELECT 'sequence', sequencename, ''
    FROM pg_sequences WHERE schemaname = 'public'
  ORDER BY 1, 2
`;

async function catalog(db) {
  const res = await db.query(CATALOG_SQL);
  return new Map(res.rows.map((r) => [`${r.kind}|${r.name}`, r.detail]));
}

const oldDdl = execSync(
  "npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script",
  { encoding: "utf8" }
);
const newDdl = execSync(
  `npx prisma migrate diff --from-empty --to-schema "${NEW_SCHEMA}" --script`,
  { encoding: "utf8" }
);

const a = new PGlite();
await a.waitReady;
await a.exec(oldDdl);
await a.exec(readFileSync("scripts/rename-db-to-english.sql", "utf8"));
console.log("[A] old schema + rename script: applied cleanly");

const b = new PGlite();
await b.waitReady;
await b.exec(newDdl);
console.log("[B] fresh new schema: applied");

const ca = await catalog(a);
const cb = await catalog(b);

let diffs = 0;
for (const [k, v] of cb) {
  if (!ca.has(k)) { console.log(`MISSING in renamed DB: ${k}  ${v ? `(${v})` : ""}`); diffs++; }
  else if (ca.get(k) !== v) { console.log(`DETAIL differs: ${k}\n  A: ${ca.get(k)}\n  B: ${v}`); diffs++; }
}
for (const k of ca.keys()) {
  if (!cb.has(k)) { console.log(`EXTRA in renamed DB: ${k}`); diffs++; }
}
console.log(diffs === 0 ? "\n✅ catalogs identical — rename script is complete" : `\n${diffs} differences — follow-up SQL needed`);
await a.close();
await b.close();
