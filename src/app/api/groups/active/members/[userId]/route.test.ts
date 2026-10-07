import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/errors";

const { mockRequireActiveGroup, mockPromoteToAdmin } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockPromoteToAdmin: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-helpers")>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/group.service", () => ({ groupService: { promoteToAdmin: mockPromoteToAdmin } }));

import { PATCH } from "./route";

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const call = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/groups/active/members/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ userId: id }) }
  );

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
});

describe("PATCH /api/groups/active/members/[userId] — make admin (spec 006)", () => {
  it("promotes through the service, scoped to the active house and the caller", async () => {
    const target = randomUUID();
    const res = await call(target, { role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockPromoteToAdmin).toHaveBeenCalledWith(7, 1, target);
  });

  it("returns the session/house failure untouched", async () => {
    mockRequireActiveGroup.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "NOT_AUTHENTICATED" }, { status: 401 }),
    });
    const res = await call(randomUUID(), { role: "ADMIN" });
    expect(res.status).toBe(401);
    expect(mockPromoteToAdmin).not.toHaveBeenCalled();
  });

  it("rejects a malformed member id with 400", async () => {
    const res = await call("not-a-uuid", { role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(mockPromoteToAdmin).not.toHaveBeenCalled();
  });

  it("rejects any role other than ADMIN with 400 INVALID_ROLE", async () => {
    const res = await call(randomUUID(), { role: "MEMBER" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ROLE");
    expect(mockPromoteToAdmin).not.toHaveBeenCalled();
  });

  it("maps the service's NOT_ADMIN refusal to 403", async () => {
    mockPromoteToAdmin.mockRejectedValue(new ApiError("Only the house admin can change roles", 403, "NOT_ADMIN"));
    const res = await call(randomUUID(), { role: "ADMIN" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ADMIN");
  });

  it("maps the service's cross-house MEMBER_NOT_FOUND to 404", async () => {
    mockPromoteToAdmin.mockRejectedValue(new ApiError("This person is no longer a member of this house", 404, "MEMBER_NOT_FOUND"));
    const res = await call(randomUUID(), { role: "ADMIN" });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("MEMBER_NOT_FOUND");
  });
});
