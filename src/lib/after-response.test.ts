import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as NextServer from "next/server";

// afterResponse lives in api-helpers (it needs next/server's after()); after() is faked here.
const { mockAfter } = vi.hoisted(() => ({ mockAfter: vi.fn() }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof NextServer>();
  return { ...actual, after: mockAfter };
});

import { afterResponse } from "@/lib/api-helpers";

beforeEach(() => vi.resetAllMocks());

describe("afterResponse (spec 009 — a notice never turns a committed write into a 500)", () => {
  it("hands the task to after() inside a request, without running it now", () => {
    const task = vi.fn(async () => undefined);
    afterResponse(task);
    expect(mockAfter).toHaveBeenCalledWith(task);
    expect(task).not.toHaveBeenCalled();
  });

  it("outside a request scope after() throws: the task runs right away and nothing is thrown", () => {
    mockAfter.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const task = vi.fn(async () => undefined);
    expect(() => afterResponse(task)).not.toThrow();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
