import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The middleware lets /api/cron/* through without a session cookie (ADR 0010), so the route itself is
// the only gate: a cron route that forgets requireCron() would be public.
describe("every cron route is guarded by requireCron (ADR 0010)", () => {
  const cronDir = path.join(process.cwd(), "src", "app", "api", "cron");
  const routes = readdirSync(cronDir, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file === "route.ts" || file.endsWith("/route.ts"));

  it("finds the cron routes (the guard below is not vacuous)", () => {
    expect(routes).toContain("recurring-expenses/route.ts");
    expect(routes).toContain("notifications/route.ts");
  });

  it.each(routes)("%s calls requireCron(", (route) => {
    expect(readFileSync(path.join(cronDir, route), "utf8")).toContain("requireCron(");
  });
});
