import { afterEach, expect, it, vi } from "vitest";
import { scrollToTop } from "./scroll";

afterEach(() => vi.unstubAllGlobals());

it("returns nothing even when scrollTo returns a Promise (newer Chrome)", () => {
  const scrollTo = vi.fn(() => Promise.resolve());
  vi.stubGlobal("window", { scrollTo });
  expect(scrollToTop()).toBeUndefined();
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});
