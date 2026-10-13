import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";

// The session gate and the revision service are faked (no pglite here — the shared test socket
// belongs to tenant-isolation.test.ts).
const { mockRequireActiveGroup, mockListForGroup } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockListForGroup: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/revision.service", () => ({ revisionService: { listForGroup: mockListForGroup } }));

import { GET } from "./route";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: n - i }));
const list = () => GET(new Request("http://localhost/api/revisions"));

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session: { userId: 1 }, groupId: 7, role: "MEMBER" });
});

describe("GET /api/revisions — hasMore (R3-21)", () => {
  it("asks for one extra row and reports older revisions", async () => {
    mockListForGroup.mockResolvedValue(rows(101));
    const body = await (await list()).json();
    expect(mockListForGroup).toHaveBeenCalledWith(7, { entityType: undefined, limit: 101 });
    expect(body.revisions).toHaveLength(100);
    expect(body.hasMore).toBe(true);
  });
  it("exactly the limit is not 'more'", async () => {
    mockListForGroup.mockResolvedValue(rows(100));
    const body = await (await list()).json();
    expect(body.revisions).toHaveLength(100);
    expect(body.hasMore).toBe(false);
  });
  it("clamps an oversized ?limit to 299, so the extra row stays within listForGroup's 300 cap", async () => {
    mockListForGroup.mockResolvedValue(rows(300));
    const body = await (await GET(new Request("http://localhost/api/revisions?limit=5000"))).json();
    expect(mockListForGroup).toHaveBeenCalledWith(7, { entityType: undefined, limit: 300 });
    expect(body.revisions).toHaveLength(299);
    expect(body.hasMore).toBe(true);
  });
  it("truncates a fractional ?limit to a whole number of rows", async () => {
    mockListForGroup.mockResolvedValue(rows(3));
    const body = await (await GET(new Request("http://localhost/api/revisions?limit=2.7"))).json();
    expect(mockListForGroup).toHaveBeenCalledWith(7, { entityType: undefined, limit: 3 });
    expect(body.revisions).toHaveLength(2);
    expect(body.hasMore).toBe(true);
  });
});
