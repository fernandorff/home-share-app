import { describe, it, expect } from "vitest";
import { robotsHeaders } from "./robots";

// Dev-environment plan, decision 9: staging (Vercel Preview on a custom domain, where Vercel omits its own
// noindex) and local dev answer X-Robots-Tag: noindex; production stays indexable.
const NOINDEX = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

describe("robotsHeaders", () => {
  it("adds nothing in Vercel Production", () => {
    expect(robotsHeaders("production")).toEqual([]);
  });

  it.each(["preview", "development", "", undefined])("adds noindex, nofollow outside production (%j)", (vercelEnv) => {
    expect(robotsHeaders(vercelEnv)).toEqual(NOINDEX);
  });
});
