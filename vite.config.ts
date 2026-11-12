// The web app (React + Vite). The Rust server (server/) serves the built dist/ and the /api routes.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { EARLY_INSTALL_CAPTURE_SCRIPT } from "./src/lib/install-prompt";

const src = fileURLToPath(new URL("./src", import.meta.url));
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Spec 009: first in <body>, before the app module, so an early beforeinstallprompt is kept. Inline
    // (not eval'd from the bundle): the CSP allows 'unsafe-inline' scripts, not 'unsafe-eval'.
    { name: "early-install-capture", transformIndexHtml: () => [{ tag: "script", children: EARLY_INSTALL_CAPTURE_SCRIPT, injectTo: "body-prepend" }] },
    // The favicon lives in src/app; the build copies it to dist/icon.svg for index.html's <link rel="icon" href="/icon.svg">.
    { name: "app-icon", generateBundle() { this.emitFile({ type: "asset", fileName: "icon.svg", source: readFileSync(src + "/app/icon.svg") }); } },
  ],
  resolve: {
    alias: [{ find: /^@\//, replacement: src + "/" }],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Public VAPID key (spec 010), read from the build environment; empty = push off.
    "process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY": JSON.stringify(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""),
  },
  build: { outDir: "dist", sourcemap: false },
  // `npm run dev`: the Rust server (`cargo run` in server/, port 8080) answers /api and /monitoring.
  server: { proxy: { "/api": "http://localhost:8080", "/monitoring": "http://localhost:8080" } },
});
