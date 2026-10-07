import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";
import { ApiError } from "@/lib/errors";

const { mockRequireActiveGroup, mockExportToCSV } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockExportToCSV: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/expense.service", () => ({ expenseService: { exportToCSV: mockExportToCSV } }));

import { GET } from "./route";

// 01:30 UTC on Oct 4 — still Oct 3 (22:30) for someone exporting in Brazil.
const SERVER_NOW = new Date("2026-10-04T01:30:00Z");
const fileName = (res: Response) => res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1];
const exportAt = (query = "") => GET(new Request(`http://localhost/api/expenses/export${query}`));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SERVER_NOW);
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session: { userId: 1 }, groupId: 7, role: "MEMBER" });
  mockExportToCSV.mockResolvedValue("description,amount\n");
});
afterEach(() => vi.useRealTimers());

describe("GET /api/expenses/export — file name date (R3-02)", () => {
  it("uses the browser's local day", async () => {
    expect(fileName(await exportAt("?date=2026-10-03"))).toBe("home-share-expenses-2026-10-03.csv");
  });
  it("exports only the active group's expenses", async () => {
    await exportAt("?date=2026-10-03");
    expect(mockExportToCSV).toHaveBeenCalledWith(7);
  });
  it("falls back to the UTC day when the date is missing or implausible", async () => {
    expect(fileName(await exportAt())).toBe("home-share-expenses-2026-10-04.csv");
    expect(fileName(await exportAt("?date=2026-09-01"))).toBe("home-share-expenses-2026-10-04.csv");
    expect(fileName(await exportAt("?date=garbage"))).toBe("home-share-expenses-2026-10-04.csv");
  });
});

describe("GET /api/expenses/export — failure", () => {
  it("answers an English message with a translatable code, not a Portuguese string", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExportToCSV.mockRejectedValue(new Error("db down"));
    const res = await exportAt("?date=2026-10-03");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to export expenses", code: "EXPORT_FAILED" });
    // the failure is still logged with the REAL error (message + stack), not a wrapper hiding it
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain("db down");
    logged.mockRestore();
  });
  it("passes a typed ApiError through with its own status and code", async () => {
    mockExportToCSV.mockRejectedValue(new ApiError("Nope", 400, "SOME_CODE"));
    const res = await exportAt("?date=2026-10-03");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Nope", code: "SOME_CODE" });
  });
});
