#!/usr/bin/env node
// Creates or updates the "Home Share — System health" Sentry dashboard from
// docs/observability/sentry-dashboard.json (spec 007). Credentials come ONLY from process.env:
// this script never loads env files, so a token is used only when exported in the current shell.
//
//   node scripts/sentry-dashboard.mjs --dry-run   # validate + list widgets; no network, no credentials
//   node scripts/sentry-dashboard.mjs             # needs SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
import { readFile } from "node:fs/promises";

const DEFINITION = new URL("../docs/observability/sentry-dashboard.json", import.meta.url);
const REQUIRED_ENV = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dashboard = JSON.parse(await readFile(DEFINITION, "utf8"));
  console.log(`Dashboard "${dashboard.title}" — ${dashboard.widgets.length} widgets:`);
  for (const widget of dashboard.widgets) console.log(`  - [${widget.widgetType}/${widget.displayType}] ${widget.title}`);
  if (dryRun) return;

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")} — export them in this shell first (env files are never read).`);
  }
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = encodeURIComponent(process.env.SENTRY_ORG);
  const project = encodeURIComponent(process.env.SENTRY_PROJECT);
  const base = (process.env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, "");

  async function api(method, path, body) {
    const response = await fetch(`${base}/api/0${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}: ${text.slice(0, 2000)}`);
    return text ? JSON.parse(text) : null;
  }

  const projectInfo = await api("GET", `/projects/${org}/${project}/`);
  const payload = { ...dashboard, projects: [Number(projectInfo.id)] };
  const listed = await api("GET", `/organizations/${org}/dashboards/?query=${encodeURIComponent(dashboard.title)}&per_page=100`);
  const existing = listed.find((item) => item.title === dashboard.title);
  if (existing) {
    // Widgets sent without ids replace the dashboard's widgets — the JSON is the source of truth.
    await api("PUT", `/organizations/${org}/dashboards/${existing.id}/`, { ...payload, id: existing.id });
    console.log(`Updated dashboard ${existing.id}.`);
  } else {
    const created = await api("POST", `/organizations/${org}/dashboards/`, payload);
    console.log(`Created dashboard ${created.id}.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
