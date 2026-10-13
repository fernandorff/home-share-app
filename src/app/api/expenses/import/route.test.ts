import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ApiHelpers from "@/lib/api-helpers";
import { POST } from "./route";

// Session gate and services are faked (no pglite socket: see groups/active/currency/route.test.ts).
// The date written for a dateless row is asserted against the real DB in tenant-isolation.test.ts.
const { mockRequireActiveGroup, mockListMembers, mockImportFromCSV, mockExpenseCreated } = vi.hoisted(() => ({
  mockRequireActiveGroup: vi.fn(),
  mockListMembers: vi.fn(),
  mockImportFromCSV: vi.fn(),
  mockExpenseCreated: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/group.service", () => ({ groupService: { listMembers: mockListMembers } }));
vi.mock("@/services/expense.service", () => ({ expenseService: { importFromCSV: mockImportFromCSV } }));
vi.mock("@/services/notification.service", () => ({ notificationService: { expenseCreated: mockExpenseCreated } }));

const session = { userId: 1, publicId: "actor", name: "Ana", sessionVersion: 1, iat: 0 };
const CSV = "description,amount\nPadaria,12.50";

// The server clock is Oct 5 01:30 UTC — still Oct 4 (22:30) for an importer in Brazil.
const SERVER_NOW = new Date("2026-10-05T01:30:00Z");

function importForm(defaultDate?: string) {
  const form = new FormData();
  form.append("file", new File([CSV], "expenses.csv", { type: "text/csv" }));
  if (defaultDate !== undefined) form.append("defaultDate", defaultDate);
  return new Request("http://localhost/api/expenses/import", { method: "POST", body: form });
}

function importJson(body: Record<string, unknown>) {
  return new Request("http://localhost/api/expenses/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv: CSV, ...body }),
  });
}

/** The `defaultDate` argument the route forwarded to the service (7th positional). */
const forwardedDefaultDate = () => mockImportFromCSV.mock.calls[0][6];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SERVER_NOW);
  mockRequireActiveGroup.mockResolvedValue({ ok: true, session, groupId: 7, role: "MEMBER" });
  mockListMembers.mockResolvedValue([{ id: 1, active: true }]);
  mockImportFromCSV.mockResolvedValue({ created: [], invalidRows: [], totalValue: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/expenses/import — importer's local date for dateless rows", () => {
  it("forwards the browser's local day from the form data", async () => {
    const res = await POST(importForm("2026-10-04"));

    expect(res.status).toBe(201);
    expect(mockImportFromCSV).toHaveBeenCalledWith(7, [1], CSV, 1, null, true, "2026-10-04");
  });

  it("forwards the browser's local day from a JSON body", async () => {
    const res = await POST(importJson({ defaultDate: "2026-10-04" }));

    expect(res.status).toBe(201);
    expect(forwardedDefaultDate()).toBe("2026-10-04");
  });

  it("forwards nothing when the field is missing (the parser keeps its UTC default)", async () => {
    await POST(importForm());
    expect(forwardedDefaultDate()).toBeUndefined();

    mockImportFromCSV.mockClear();
    await POST(importJson({}));
    expect(forwardedDefaultDate()).toBeUndefined();
  });

  it.each(["not-a-date", "2026-02-30", "04/10/2026", "2026-10-02", "2026-10-08", ""])(
    "ignores the unusable form value %j and still imports",
    async (garbage) => {
      const res = await POST(importForm(garbage));

      expect(res.status).toBe(201);
      expect(forwardedDefaultDate()).toBeUndefined();
    }
  );

  it("ignores a non-string JSON value and still imports", async () => {
    const res = await POST(importJson({ defaultDate: 20261004 }));

    expect(res.status).toBe(201);
    expect(forwardedDefaultDate()).toBeUndefined();
  });
});

describe("POST /api/expenses/import — no notices (spec 009, criterion 4)", () => {
  it("a CSV import creates expenses without any EXPENSE_NEW notice", async () => {
    mockImportFromCSV.mockResolvedValue({ created: [{ id: 1 }, { id: 2 }], invalidRows: [], totalValue: 25 });
    const res = await POST(importForm("2026-10-04"));

    expect(res.status).toBe(201);
    expect(mockExpenseCreated).not.toHaveBeenCalled();
  });
});
