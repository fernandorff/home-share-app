import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Dev-environment plan, decisions 6 and 10: the schema changes only through `prisma migrate deploy`, run by hand
// (staging first); CI gates PRs into `dev` as well as `main`.
// CRLF → LF: core.autocrlf checkouts on Windows rewrite line endings.
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;

describe("package.json scripts", () => {
  it("builds without touching a database", () => {
    expect(scripts.build).toBe("prisma generate && next build");
    expect(scripts.build).not.toMatch(/db push|migrate/);
  });

  it("no script builds a schema with `prisma db push` (a pushed database later fails `migrate deploy` with P3005)", () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect({ name, command }).not.toMatchObject({ command: expect.stringMatching(/db push/) });
    }
  });

  it("applies and inspects migrations explicitly", () => {
    expect(scripts["db:migrate"]).toBe("prisma migrate deploy");
    expect(scripts["db:migrate:status"]).toBe("prisma migrate status");
    expect(scripts["db:reset"]).toMatch(/&& npx prisma migrate deploy$/);
  });
});

describe("CI workflow", () => {
  it("runs on push and pull_request to main and dev", () => {
    const trigger = read(".github/workflows/test.yml").match(/^on:\n([\s\S]*?)\n\S/m)?.[1] ?? "";
    expect(trigger).toMatch(/push:\n\s+branches: \[main, dev\]/);
    expect(trigger).toMatch(/pull_request:\n\s+branches: \[main, dev\]/);
  });

  it("fails when schema.prisma changes without a migration", () => {
    expect(read(".github/workflows/test.yml")).toContain(
      "npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code"
    );
  });
});
