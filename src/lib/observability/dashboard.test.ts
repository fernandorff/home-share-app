import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

interface Query { fields: string[]; aggregates: string[]; columns: string[]; conditions: string; orderby: string }
interface Widget {
  title: string;
  displayType: string;
  widgetType: string;
  queries: Query[];
  layout: { x: number; y: number; w: number; h: number };
}

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const dashboard = JSON.parse(read("docs/observability/sentry-dashboard.json")) as { title: string; widgets: Widget[] };
const script = read("scripts/sentry-dashboard.mjs");

const WIDGET_TYPES = new Set(["error-events", "spans", "metrics"]);
const DISPLAY_TYPES = new Set(["line", "area", "bar", "table", "big_number"]);
const q = (widget: Widget) => widget.queries[0];

describe("Sentry dashboard definition (R15)", () => {
  it("has the idempotency title and only valid widgets on the 6-column grid", () => {
    expect(dashboard.title).toBe("Home Share — System health");
    for (const widget of dashboard.widgets) {
      expect(WIDGET_TYPES.has(widget.widgetType), widget.title).toBe(true);
      expect(DISPLAY_TYPES.has(widget.displayType), widget.title).toBe(true);
      expect(widget.queries.length, widget.title).toBeGreaterThan(0);
      for (const query of widget.queries) {
        expect(query.aggregates.length, widget.title).toBeGreaterThan(0);
        for (const name of [...query.aggregates, ...query.columns]) expect(query.fields, widget.title).toContain(name);
      }
      expect(widget.layout.x + widget.layout.w, widget.title).toBeLessThanOrEqual(6);
    }
  });

  it.each<[string, (widget: Widget) => boolean]>([
    ["errors by route", (w) => w.widgetType === "error-events" && q(w).columns.includes("route")],
    ["top error codes on 5xx", (w) => w.widgetType === "error-events" && q(w).columns.includes("api_error_code") && q(w).conditions.includes("http_status:5*")],
    ["p95 latency by route", (w) => w.widgetType === "spans" && q(w).aggregates.includes("p95(span.duration)") && q(w).columns.includes("transaction") && q(w).conditions.includes("span.op:http.server")],
    ["DB query p95", (w) => w.widgetType === "spans" && q(w).aggregates.includes("p95(span.duration)") && q(w).conditions.includes("span.category:db")],
    ["LCP", (w) => q(w).aggregates.includes("p75(measurements.lcp)")],
    ["INP", (w) => q(w).aggregates.includes("p75(measurements.inp)")],
    ["CLS", (w) => q(w).aggregates.includes("p75(measurements.cls)")],
    ["crash-free sessions/users", (w) => w.widgetType === "metrics" && q(w).aggregates.includes("crash_free_rate(session)") && q(w).aggregates.includes("crash_free_rate(user)")],
    ["transactions per minute", (w) => w.widgetType === "spans" && q(w).aggregates.includes("epm()") && q(w).conditions.includes("is_transaction:true")],
  ])("covers %s", (_name, predicate) => {
    expect(dashboard.widgets.some(predicate)).toBe(true);
  });

  it("the sync script takes credentials only from process.env — never env files", () => {
    expect(script).not.toMatch(/dotenv/);
    expect(script).not.toMatch(/["'`][^"'`\n]*\.env[^"'`\n]*["'`]/);
    for (const name of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]) expect(script).toContain(name);
    expect(script).toContain("--dry-run");
  });
});
