import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "@/i18n/locales";
import * as request from "@/i18n/request";

// The locale list lives in a framework-free module (spec 010): browser code (the push client helpers) and the
// push validators share it without pulling next-intl/server + next/headers into their graph. request.ts keeps
// re-exporting it, so nothing that imported it from there changes.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("src/i18n/locales — pure locale list", () => {
  it("lists the four app locales", () => {
    expect(LOCALES).toEqual(["en", "pt", "es", "fr"]);
  });

  it("is re-exported unchanged by src/i18n/request (the same array, not a copy)", () => {
    expect(request.LOCALES).toBe(LOCALES);
  });

  it("imports nothing at all", () => {
    expect(read("src/i18n/locales.ts")).not.toMatch(/^\s*import\b|\brequire\(/m);
  });

  it.each(["src/lib/push/endpoint.ts", "src/lib/push/payload.ts"])(
    "%s takes the locales from the pure module, never from request.ts or next/*",
    (path) => {
      const source = read(path);
      expect(source).toMatch(/from "@\/i18n\/locales"/);
      expect(source).not.toMatch(/from ["'](?:@\/i18n\/request|next\/)/);
    }
  );
});
