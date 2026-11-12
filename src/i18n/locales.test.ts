import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "@/i18n/locales";

// The locale list lives in a framework-free module (spec 010): browser code (the push client helpers) shares it
// without pulling any i18n runtime into its graph.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("src/i18n/locales — pure locale list", () => {
  it("lists the four app locales", () => {
    expect(LOCALES).toEqual(["en", "pt", "es", "fr"]);
  });

  it("imports nothing at all", () => {
    expect(read("src/i18n/locales.ts")).not.toMatch(/^\s*import\b|\brequire\(/m);
  });
});
