#!/usr/bin/env node
// Renders the installable-app icons (spec 009) from src/app/icon.svg into public/icons/ with
// @resvg/resvg-js (exact-pinned devDependency, prebuilt binaries). Run once after changing the icon and
// commit the PNGs. It reads no env files and makes no network calls.
//
//   node scripts/generate-pwa-icons.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const SOURCE = new URL("../src/app/icon.svg", import.meta.url);
const OUT_DIR = new URL("../public/icons/", import.meta.url);
// Launchers crop a maskable icon to any shape that holds the centered circle of 80 % diameter, so the
// glyph is drawn at 80 % of its size around the center on a full-bleed background.
const MASKABLE_GLYPH_SCALE = 0.8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** icon.svg = a square viewBox, one rounded background <rect> and the glyph. Fails loudly if that changes. */
function parseIcon(svg) {
  const viewBox = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!viewBox || viewBox[1] !== viewBox[2]) throw new Error("icon.svg must have a square `0 0 N N` viewBox");
  const size = Number(viewBox[1]);
  const rects = svg.match(/<rect\b[^>]*\/>/g) ?? [];
  const background = rects.find((rect) => rect.includes(`width="${size}"`) && rect.includes(`height="${size}"`));
  const fill = background?.match(/fill="(#[0-9a-fA-F]{3,8})"/)?.[1];
  if (!background || !fill) throw new Error("icon.svg must start with a full-size background <rect> with a hex fill");
  const inner = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)?.[1];
  if (!inner) throw new Error("icon.svg has no <svg> content");
  return { size, fill, glyph: inner.replace(background, "").trim() };
}

/** The glyph on a full-bleed square of the background color (no rounded corners, nothing transparent). */
function fullBleed({ size, fill, glyph }, scale) {
  const c = size / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${fill}" />`,
    `<g transform="translate(${c} ${c}) scale(${scale}) translate(${-c} ${-c})">${glyph}</g>`,
    `</svg>`,
  ].join("");
}

function render(svg, width, background) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, background, font: { loadSystemFonts: false } }).render();
}

function chunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encodes an opaque render as an RGB PNG (color type 2, no alpha channel), so "no transparency" holds by
 * construction and the contract test can check it from the header. resvg itself always writes RGBA.
 */
function encodeOpaquePng({ width, height, pixels }) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      if (pixels[from + 3] !== 255) throw new Error(`pixel ${x},${y} is not opaque`);
      pixels.copy(raw, y * stride + 1 + x * 3, from, from + 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // color type: truecolor
  // compression, filter and interlace methods stay 0
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const svg = await readFile(SOURCE, "utf8");
  const icon = parseIcon(svg);
  const outputs = [
    // purpose "any": the favicon as is (rounded corners, transparent outside them)
    { file: "icon-192.png", png: () => render(svg, 192).asPng() },
    { file: "icon-512.png", png: () => render(svg, 512).asPng() },
    { file: "maskable-512.png", png: () => encodeOpaquePng(render(fullBleed(icon, MASKABLE_GLYPH_SCALE), 512, icon.fill)) },
    // iOS applies its own rounded mask and paints transparent pixels black: full-bleed, opaque
    { file: "apple-touch-icon.png", png: () => encodeOpaquePng(render(fullBleed(icon, 1), 180, icon.fill)) },
  ];
  await mkdir(OUT_DIR, { recursive: true });
  for (const { file, png } of outputs) {
    const bytes = png();
    await writeFile(new URL(file, OUT_DIR), bytes);
    console.log(`public/icons/${file} — ${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}, ${bytes.length} bytes`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
