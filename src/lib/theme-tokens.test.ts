import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Spec 011 (criterion 3): a theme preview is a `[data-theme]` wrapper, so both palettes must be declared for any
// element — the default one too, or a default preview inside a bolitas page inherits the bolitas values.
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** Custom properties of the first rule whose selector is exactly `selector` (or the @theme block). */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("\n}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

describe("theme tokens on any element (spec 011, criterion 3)", () => {
  const theme = tokens("@theme");
  const fallback = tokens('[data-theme="default"]');
  const bolitas = tokens('[data-theme="bolitas"]');

  it("scopes every theme selector to the attribute alone, not to <html>", () => {
    expect(css).not.toContain("html[data-theme");
  });

  it("re-declares every token the bolitas theme overrides, so a default preview never inherits a bolitas value", () => {
    expect([...bolitas.keys()].filter((name) => !fallback.has(name))).toEqual([]);
  });

  it("re-declares them with the exact @theme values (no drift between the two copies)", () => {
    for (const [name, value] of fallback) expect(`${name}: ${value}`).toBe(`${name}: ${theme.get(name)}`);
  });
});
