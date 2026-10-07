import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";

// Same setup as groups/active/currency/route.test.ts: the session gate, the activity log and the
// service are faked, so no test here touches the shared pglite socket.
const { mockRequireActiveGroup, mockRecordActivity, mockRegenerate } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockRecordActivity: vi.fn(),
  mockRegenerate: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup, recordActivity: mockRecordActivity };
});
vi.mock("@/services/group.service", () => ({ groupService: { regenerateJoinCode: mockRegenerate } }));

import { POST } from "./route";

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  mockRegenerate.mockResolvedValue("NEW999");
});

describe("POST /api/groups/active/regenerate-code (R3-19)", () => {
  it("records a Summary entry with the marker only — never the code", async () => {
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "ADMIN" });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ joinCode: "NEW999" });
    expect(mockRecordActivity).toHaveBeenCalledWith({
      groupId: 7, actorId: 1, entityType: "GROUP", action: "UPDATE", summary: "", changes: { joinCodeChanged: true },
    });
    expect(JSON.stringify(mockRecordActivity.mock.calls)).not.toContain("NEW999");
  });
  it("a member is refused and nothing is recorded", async () => {
    mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
    const res = await POST();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_ADMIN");
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockRecordActivity).not.toHaveBeenCalled();
  });
});
