import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";

// Same setup as groups/active/members/[userId]/route.test.ts: the session gate, the activity log and
// the service are faked, so no test here touches the shared pglite socket (a second DB-backed test
// file races the one in tenant-isolation.test.ts and dies with "Server has closed the connection").
// What the real DB records for the same-currency no-op is asserted at the service level there.
const { mockRequireActiveGroup, mockRecordActivity, mockUpdateCurrency } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockUpdateCurrency: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/group.service", () => ({ groupService: { updateCurrency: mockUpdateCurrency } }));

import { POST } from "./route";

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const pickCurrency = (currency: unknown) =>
  POST(new Request("http://localhost/api/groups/active/currency", { method: "POST", body: JSON.stringify({ currency }) }));

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
});

describe("POST /api/groups/active/currency (R2-08)", () => {
  it("picking the active currency answers 200 { currency } and records no activity", async () => {
    mockUpdateCurrency.mockResolvedValue({ previousCurrency: "BRL", changed: false });

    const res = await pickCurrency("BRL");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ currency: "BRL" });
    expect(mockUpdateCurrency).toHaveBeenCalledWith(7, "BRL");
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("picking a different currency answers 200 and records the from → to activity entry for the caller's house", async () => {
    mockUpdateCurrency.mockResolvedValue({ previousCurrency: "BRL", changed: true });

    const res = await pickCurrency("USD");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ currency: "USD" });
    expect(mockUpdateCurrency).toHaveBeenCalledWith(7, "USD");
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity).toHaveBeenCalledWith({
      groupId: 7,
      actorId: 1,
      entityType: "GROUP",
      action: "UPDATE",
      summary: "USD",
      changes: { currency: { from: "BRL", to: "USD" } },
    });
  });

  it("changing and then re-picking the new currency records only the real change", async () => {
    mockUpdateCurrency
      .mockResolvedValueOnce({ previousCurrency: "BRL", changed: true })
      .mockResolvedValueOnce({ previousCurrency: "EUR", changed: false });

    await pickCurrency("EUR");
    const again = await pickCurrency("EUR");

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ currency: "EUR" });
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-admin with 403 NOT_ADMIN before touching the house", async () => {
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });

    const res = await pickCurrency("USD");

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ADMIN");
    expect(mockUpdateCurrency).not.toHaveBeenCalled();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("rejects an unknown currency with 400 INVALID_CURRENCY", async () => {
    const res = await pickCurrency("XXX");

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_CURRENCY");
    expect(mockUpdateCurrency).not.toHaveBeenCalled();
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });

    const res = await pickCurrency("USD");

    expect(res.status).toBe(401);
    expect(mockUpdateCurrency).not.toHaveBeenCalled();
  });
});
