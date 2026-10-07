#!/usr/bin/env node
// Vercel Ignored Build Step (dev-environment plan, decision 4): only `main` (Production) and `dev` (staging) deploy;
// every other branch runs only the GitHub CI. Wired as `ignoreCommand` in vercel.json, which overrides the
// dashboard setting. Vercel's exit codes are the reverse of the usual pass/fail reading:
//   exit 0 → SKIP: the build is aborted and the deployment is set to CANCELED
//   exit 1 → BUILD: the build continues as normal (a crash also exits 1, so an error never blocks a deploy)
// It reads only VERCEL_GIT_COMMIT_REF (the Git branch, a system env var available at build time). A deployment
// without Git metadata has no ref and is skipped; redeploy it with "Use project's Ignore Build Step" unchecked.
//
//   node scripts/vercel-ignore-build.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True only for a branch that deploys: `main` → Production, `dev` → staging (exact name).
 * @param {string | undefined} ref
 * @returns {boolean}
 */
export function shouldBuild(ref) {
  return ref === "main" || ref === "dev";
}

// Only when run as a script, never when a test imports shouldBuild.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ref = process.env.VERCEL_GIT_COMMIT_REF;
  if (shouldBuild(ref)) {
    console.log(`Building "${ref}" (only main and dev deploy).`);
    process.exit(1);
  }
  console.log(`Skipping "${ref ?? ""}": only main and dev deploy; other branches run only the GitHub CI.`);
  process.exit(0);
}
