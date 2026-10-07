import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Radix mounts Dialog.Content only on the client (Portal), so renderToStaticMarkup renders nothing and there
// is no DOM environment here — pin the placement contract on the class list in the source instead.
const source = readFileSync(join(process.cwd(), "src/components/ui/Modal.tsx"), "utf8");

describe("Modal placement (R3-13 / R3-06)", () => {
  it("anchors the desktop dialog 4.5rem from the top instead of centering it", () => {
    // Centered, a dialog whose body grows (error, import result) moved its title up and its footer down.
    expect(source).toContain("sm:top-[4.5rem]");
    expect(source).not.toMatch(/sm:top-1\/2|-translate-y-1\/2/);
  });

  it("keeps the horizontal centering that anim-sheet leaves alone (translate vs transform)", () => {
    expect(source).toContain("sm:left-1/2");
    expect(source).toContain("sm:-translate-x-1/2");
  });

  it("caps the height so the body scrolls instead of the dialog overflowing, below and above sm", () => {
    expect(source).toContain("max-h-[calc(100dvh-4.5rem)]");
    expect(source).toContain("sm:max-h-[calc(100dvh-6rem)]");
    expect(source).not.toContain("max-h-[92dvh]");
  });
});
