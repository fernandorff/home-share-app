import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";

// Session gate, activity log and service are faked (no pglite socket: see groups/active/currency/route.test.ts).
// The "same set twice writes one revision" half of I2 is asserted against the real DB in tenant-isolation.test.ts.
const { mockRequireActiveGroup, mockRecordActivity, mockReplaceExpenseLinks } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockReplaceExpenseLinks: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/shopping-item.service", () => ({
  shoppingItemService: { replaceExpenseLinks: mockReplaceExpenseLinks },
}));

import { PUT } from "./route";

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const itemId = randomUUID();
const [expenseA, expenseB] = [randomUUID(), randomUUID()];
const item = { publicId: itemId, name: "Milk", linkedExpenses: [] };

const save = (body: unknown) =>
  PUT(new Request(`http://localhost/api/shopping-items/${itemId}/expenses`, { method: "PUT", body: JSON.stringify(body) }), {
    params: Promise.resolve({ itemId }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
});

describe("PUT /api/shopping-items/[itemId]/expenses — activity entry only for a real change (I2)", () => {
  it("records the link change when the service reports changed", async () => {
    mockReplaceExpenseLinks.mockResolvedValue({ item, changed: true });

    const res = await save({ expenseIds: [expenseA, expenseB, expenseA] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ item });
    expect(mockReplaceExpenseLinks).toHaveBeenCalledWith(7, itemId, [expenseA, expenseB], 1);
    expect(mockRecordActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordActivity).toHaveBeenCalledWith({
      groupId: 7,
      actorId: 1,
      entityType: "SHOPPING_ITEM",
      entityId: itemId,
      action: "UPDATE",
      summary: "Milk",
      changes: { linkedExpenseIds: [expenseA, expenseB] },
    });
  });

  it("answers 200 { item } and records nothing when the saved set was already the linked set", async () => {
    mockReplaceExpenseLinks.mockResolvedValue({ item, changed: false });

    const res = await save({ expenseIds: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ item });
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("records nothing when the service refuses", async () => {
    mockReplaceExpenseLinks.mockRejectedValue(new ApiError("Item not found", 404));

    const res = await save({ expenseIds: [expenseA] });

    expect(res.status).toBe(404);
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });

    const res = await save({ expenseIds: [] });

    expect(res.status).toBe(401);
    expect(mockReplaceExpenseLinks).not.toHaveBeenCalled();
  });
});
