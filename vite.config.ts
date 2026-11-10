// Vite web build for the Rust server (spec 013, 4.1): same src/app pages, Next APIs swapped for small shims.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { EARLY_INSTALL_CAPTURE_SCRIPT } from "./src/lib/install-prompt";

const src = fileURLToPath(new URL("./src", import.meta.url));
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Spec 009: first in <body>, before the app module, so an early beforeinstallprompt is kept. Inline
    // (not eval'd from the bundle): the CSP allows 'unsafe-inline' scripts, not 'unsafe-eval'.
    { name: "early-install-capture", transformIndexHtml: () => [{ tag: "script", children: EARLY_INSTALL_CAPTURE_SCRIPT, injectTo: "body-prepend" }] },
  ],
  resolve: {
    alias: [
      { find: /^@\//, replacement: src + "/" },
      { find: /^next\/navigation$/, replacement: src + "/vite/shims/navigation.ts" },
      { find: /^next\/link$/, replacement: src + "/vite/shims/link.tsx" },
      { find: /^next-intl$/, replacement: src + "/vite/shims/intl.ts" },
      { find: /^@sentry\/nextjs$/, replacement: "@sentry/react" },
    ],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Same public VAPID key as the Next build (spec 010), read from the build environment; empty = push off.
    "process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY": JSON.stringify(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ""),
  },
  build: { outDir: "dist", sourcemap: false },
  // `vite preview` stands in for Axum in the screenshot comparison (server/gate/screens.mjs): /api goes to
  // the Next server named by PREVIEW_API, so both sides read the same data.
  preview: process.env.PREVIEW_API ? { proxy: { "/api": process.env.PREVIEW_API } } : undefined,
});
