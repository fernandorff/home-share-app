import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const CODE_FILES = ["vite.config.ts", "src/vite/main.tsx", "server/src/observability.rs", "server/src/config.rs", "scripts/sentry-dashboard.mjs"];

describe("observability docs (R16)", () => {
  it("documents every Sentry env var the code reads", () => {
    const names = new Set(CODE_FILES.flatMap((file) => read(file).match(/\b(?:VITE_)?SENTRY_[A-Z_]+\b/g) ?? []));
    const guide = read("docs/observability.md");
    expect(names.size).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(guide, name).toContain(name);
  });

  it("records the decision in ADR 0008 and indexes it", () => {
    expect(read("docs/decisions/0008-observability-sentry.md")).toMatch(/^# Observability via Sentry/);
    expect(read("docs/decisions/README.md")).toContain("0008-observability-sentry.md");
  });
});
