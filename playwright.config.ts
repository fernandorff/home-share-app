import { defineConfig, devices } from "@playwright/test";

// Smoke E2E against a running app (`next start` after `next build`) and a real, disposable Postgres.
// CI starts the server through `webServer`; locally, point E2E_BASE_URL at an app already running.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npx next start -p 3000 -H localhost", url: `${baseURL}/api/health`, timeout: 60_000 },
});
