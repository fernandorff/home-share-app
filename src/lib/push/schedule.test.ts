import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";

// schedulePush sends the push after the response (Next's after()); outside a request scope after() throws, so the
// dispatch runs right away and is tracked for flushPush() — the pattern of prisma-audit's deferred revision writes.
const { mockAfter, mockDispatch } = vi.hoisted(() => ({ mockAfter: vi.fn(), mockDispatch: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof NextServer>()), after: mockAfter }));
vi.mock("@/services/push.service", () => ({ pushService: { dispatch: mockDispatch } }));

import { flushPush, schedulePush } from "@/lib/push/schedule";

type Rows = Parameters<typeof schedulePush>[0];
const rows = [{ userId: 3, groupId: 1, type: "EXPENSE_NEW", actorId: 7, params: { description: "Milk", amount: "5.00" } }] as Rows;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "private-key");
  vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
  mockDispatch.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("schedulePush (spec 010, criteria 1, 6, 7)", () => {
  it("push not configured: nothing is scheduled or sent (criterion 1)", () => {
    vi.stubEnv("VAPID_SUBJECT", "");
    schedulePush(rows);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("no inserted row: nothing is scheduled", () => {
    schedulePush([]);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("inside a request: hands the dispatch of exactly these rows to after(), so it runs once the response is out", async () => {
    schedulePush(rows);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    await mockAfter.mock.calls[0][0]();
    expect(mockDispatch).toHaveBeenCalledWith(rows);
  });

  it("outside a request (after() throws): never throws into the producer; the dispatch starts now and flushPush() waits for it", async () => {
    mockAfter.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    let release!: () => void;
    mockDispatch.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));

    expect(() => schedulePush(rows)).not.toThrow();
    expect(mockDispatch).toHaveBeenCalledWith(rows);

    let flushed = false;
    const flushing = flushPush().then(() => (flushed = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(flushed).toBe(true);
  });

  it("flushPush with nothing pending resolves at once", async () => {
    await expect(flushPush()).resolves.toBeUndefined();
  });
});
