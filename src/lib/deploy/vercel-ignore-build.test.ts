import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { shouldBuild } from "../../../scripts/vercel-ignore-build.mjs";

// Dev-environment plan, decision 4: only `main` (Production) and `dev` (staging) deploy on Vercel.
const SCRIPT = path.join(process.cwd(), "scripts/vercel-ignore-build.mjs");

/** Runs the CLI as Vercel does, with VERCEL_GIT_COMMIT_REF set to `ref` (or removed when undefined). */
function runCli(ref: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VERCEL_GIT_COMMIT_REF;
  if (ref !== undefined) env.VERCEL_GIT_COMMIT_REF = ref;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
}

describe("shouldBuild (Vercel Ignored Build Step)", () => {
  it.each(["main", "dev"])("builds %s", (ref) => {
    expect(shouldBuild(ref)).toBe(true);
  });

  it.each(["feat/ui-loop-and-pocs", "maint", "dev2", "feature/dev", "DEV", " main", "", undefined])(
    "skips %j",
    (ref) => {
      expect(shouldBuild(ref)).toBe(false);
    }
  );
});

describe("vercel-ignore-build CLI (exit 0 = skip, exit 1 = build)", () => {
  it.each(["main", "dev"])("exits 1 (build) on %s", (ref) => {
    const result = runCli(ref);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain(ref);
  });

  it.each(["feat/ui-loop-and-pocs", "", undefined])("exits 0 (skip) on %j", (ref) => {
    const result = runCli(ref);
    expect(result.status, result.stderr).toBe(0);
  });

  it("is wired as vercel.json ignoreCommand, keeping the build command and the crons", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"));
    expect(vercel.ignoreCommand).toBe("node scripts/vercel-ignore-build.mjs");
    expect(vercel.buildCommand).toBe("prisma generate && next build");
    expect(vercel.crons.map((cron: { path: string }) => cron.path)).toEqual([
      "/api/cron/recurring-expenses",
      "/api/cron/notifications",
    ]);
  });
});
