import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Contract of the installable-app shell (spec 009 — criterion 1): the static manifest, the PNG icons it
// references and the root layout's metadata. The icon sizes come from each file's PNG header (IHDR), so
// no image library is needed at test time.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const publicFile = (src: string) => join(root, "public", src);

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(read("public/manifest.json")) as Record<string, unknown> & { icons: ManifestIcon[] };
const layout = read("src/app/layout.tsx");
const globalsCss = read("src/app/globals.css");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR color types: 2 = truecolor (RGB, no alpha channel), 6 = truecolor with alpha.
const COLOR_TYPE_RGB = 2;

/** Width, height and color type from the IHDR chunk, which the PNG spec requires to come first. */
function pngHeader(path: string) {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(bytes.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes.readUInt8(25) };
}

/** Chunk types in file order (to spot a tRNS chunk, which would add transparency to an RGB image). */
function pngChunkTypes(path: string): string[] {
  const bytes = readFileSync(path);
  const types: string[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    types.push(bytes.toString("latin1", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

/** A design token of the default theme (the first `@theme` block of globals.css). */
function themeToken(name: string): string {
  const match = globalsCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token --${name} not found`);
  return match[1].toLowerCase();
}

describe("public/manifest.json (spec 009 — criterion 1)", () => {
  it("names the app and opens standalone at /expenses inside the whole origin", () => {
    expect(manifest).toMatchObject({
      id: "/",
      name: "Home Share",
      short_name: "Home Share",
      start_url: "/expenses",
      scope: "/",
      display: "standalone",
    });
    expect(typeof manifest.description).toBe("string");
  });

  it("uses the retro-mono palette: ink as theme color, paper as background", () => {
    expect(manifest.theme_color).toBe("#16140f");
    expect(manifest.background_color).toBe("#f2f0e9");
    expect(manifest.theme_color).toBe(themeToken("color-ink"));
    expect(manifest.background_color).toBe(themeToken("color-paper"));
  });

  it("lists 192 and 512 PNG icons plus a 512 maskable one, all under /icons/", () => {
    expect(manifest.icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it.each(manifest.icons.map((icon) => [icon.src, icon] as const))("%s exists and its PNG size equals `sizes`", (src, icon) => {
    expect(existsSync(publicFile(src))).toBe(true);
    const { width, height } = pngHeader(publicFile(src));
    expect(`${width}x${height}`).toBe(icon.sizes);
  });

  it("the maskable icon is fully opaque (full-bleed background, launchers crop it)", () => {
    const maskable = manifest.icons.find((icon) => icon.purpose === "maskable");
    expect(maskable).toBeDefined();
    const path = publicFile(maskable!.src);
    expect(pngHeader(path).colorType).toBe(COLOR_TYPE_RGB);
    expect(pngChunkTypes(path)).not.toContain("tRNS");
  });
});

describe("apple-touch-icon (spec 009 — criterion 1)", () => {
  const path = publicFile("/icons/apple-touch-icon.png");

  it("is a 180×180 PNG", () => {
    expect(existsSync(path)).toBe(true);
    const { width, height } = pngHeader(path);
    expect([width, height]).toEqual([180, 180]);
  });

  it("has no transparency (iOS paints transparent pixels black)", () => {
    expect(pngHeader(path).colorType).toBe(COLOR_TYPE_RGB);
    expect(pngChunkTypes(path)).not.toContain("tRNS");
  });
});

describe("root layout metadata (spec 009 — criterion 1)", () => {
  it("links the static manifest (not app/manifest.ts, whose /manifest.webmanifest the middleware gates)", () => {
    expect(layout).toMatch(/manifest:\s*"\/manifest\.json"/);
    expect(existsSync(join(root, "src/app/manifest.ts"))).toBe(false);
  });

  it("declares the Apple web-app metadata: capable, titled Home Share", () => {
    expect(layout).toMatch(/appleWebApp:\s*\{[^}]*capable:\s*true/);
    expect(layout).toMatch(/appleWebApp:\s*\{[^}]*title:\s*"Home Share"/);
  });

  it("also emits the legacy apple-mobile-web-app-capable tag (Next 16 writes only mobile-web-app-capable; iOS < 16.4 reads the apple one)", () => {
    expect(layout).toMatch(/other:\s*\{\s*"apple-mobile-web-app-capable":\s*"yes"\s*\}/);
  });

  it("declares the 180×180 apple-touch-icon and keeps the favicon (config icons replace the file-based ones)", () => {
    expect(layout).toMatch(/apple:\s*\{[^}]*url:\s*"\/icons\/apple-touch-icon\.png"[^}]*sizes:\s*"180x180"/);
    expect(layout).toMatch(/icon:\s*\{[^}]*url:\s*"\/icon\.svg"/);
    expect(existsSync(join(root, "src/app/icon.svg"))).toBe(true);
  });

  it("keeps the theme color in the viewport export, equal to the manifest's", () => {
    const viewport = layout.match(/export const viewport: Viewport = \{([^}]*)\}/);
    expect(viewport).not.toBeNull();
    expect(viewport![1]).toContain(`themeColor: "${manifest.theme_color}"`);
    // Next 16 moved themeColor out of `metadata`; keeping it there is deprecated.
    const metadata = layout.match(/export const metadata: Metadata = \{([\s\S]*?)\n\};/);
    expect(metadata).not.toBeNull();
    expect(metadata![1]).not.toContain("themeColor");
  });
});
