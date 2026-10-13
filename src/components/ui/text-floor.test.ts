import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// A7: 12px (0.75rem) is the floor for any text. Tailwind's named sizes are all >= 12px
// (`text-xs` is the smallest), so the only ways under it are an arbitrary size like
// `text-[0.7rem]` / `text-[11px]` or a made-up sub-xs name — scan every component for them.
const ROOT = join(process.cwd(), "src");
const tsxFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });

const toPx = (value: number, unit: string) => (unit === "px" ? value : value * 16);

describe("12px text floor (A7)", () => {
  it("no arbitrary text size under 0.75rem / 12px", () => {
    const offenders = tsxFiles(ROOT).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/text-\[(\d*\.?\d+)(rem|em|px)\]/g)]
        .filter((m) => toPx(Number(m[1]), m[2]) < 12)
        .map((m) => `${relative(ROOT, file)}: ${m[0]}`)
    );
    expect(offenders).toEqual([]);
  });

  it("no named size below text-xs", () => {
    const offenders = tsxFiles(ROOT).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?<![\w-])text-(?:[2-9]xs|xxs|tiny|micro)(?![\w-])/g)].map(
        (m) => `${relative(ROOT, file)}: ${m[0]}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
