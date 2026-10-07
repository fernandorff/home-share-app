import { describe, it, expect, vi, afterEach } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { auditExtension, flushAudit, WRITE_OPS } from "@/lib/prisma-audit";
import { logger } from "@/lib/logger";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Every action Prisma knows, classified. `satisfies Record<Prisma.PrismaAction, …>` makes `tsc --noEmit` (a gate)
// fail when a Prisma upgrade adds an action nobody classified here — createManyAndReturn / updateManyAndReturn
// arrived that way and the audit extension skipped them silently until the spec 009 final review. Raw SQL is not a
// model operation (the extension never sees it): those writes record their revision explicitly (ADR 0009).
// No database here: the real-DB revision cases live in src/services/tenant-isolation.test.ts.
const PRISMA_ACTIONS = {
  findUnique: "read",
  findUniqueOrThrow: "read",
  findMany: "read",
  findFirst: "read",
  findFirstOrThrow: "read",
  aggregate: "read",
  count: "read",
  groupBy: "read",
  create: "write",
  createMany: "write",
  createManyAndReturn: "write",
  update: "write",
  updateMany: "write",
  updateManyAndReturn: "write",
  upsert: "write",
  delete: "write",
  deleteMany: "write",
  executeRaw: "raw",
  queryRaw: "raw",
  runCommandRaw: "raw",
  findRaw: "raw",
} as const satisfies Record<Prisma.PrismaAction, "read" | "write" | "raw">;

describe("audit extension: which operations it records (ADR 0005)", () => {
  it("WRITE_OPS is exactly every Prisma write operation — none skipped, no read recorded", () => {
    const writes = Object.entries(PRISMA_ACTIONS)
      .filter(([, kind]) => kind === "write")
      .map(([action]) => action);
    expect([...WRITE_OPS].sort()).toEqual(writes.sort());
  });
});

// The extension object, captured without a database: Prisma.defineExtension(obj) is `client => client.$extends(obj)`.
type AllOperations = (params: {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

function captureExtension() {
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const base = { entityRevision: { createMany } } as unknown as PrismaClient;
  const define = auditExtension(base) as unknown as (client: { $extends: (ext: unknown) => unknown }) => {
    query: { $allModels: { $allOperations: AllOperations } };
  };
  return { allOperations: define({ $extends: (ext) => ext }).query.$allModels.$allOperations, createMany };
}

describe("audit extension: a write it has no branch for (POC 009 re-review)", () => {
  afterEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  it("logs 'audit: write not recorded' with ids only — never the data — and still returns the write's result", async () => {
    const { allOperations, createMany } = captureExtension();
    const writeOps = WRITE_OPS as Set<string>;
    writeOps.add("futureWrite"); // a Prisma action added to WRITE_OPS before the extension learns to record it
    try {
      const args = { data: { description: "Rent", amount: "1800.00" } };
      const query = vi.fn().mockResolvedValue({ id: 7, description: "Rent" });

      const result = await allOperations({ model: "Expense", operation: "futureWrite", args, query });
      await flushAudit();

      expect(query).toHaveBeenCalledWith(args);
      expect(result).toEqual({ id: 7, description: "Rent" });
      expect(createMany).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("audit: write not recorded", { entityType: "Expense", operation: "futureWrite" });
    } finally {
      writeOps.delete("futureWrite");
    }
  });

  it("a handled write records its revision and logs nothing (control)", async () => {
    const { allOperations, createMany } = captureExtension();
    const query = vi.fn().mockResolvedValue({ id: 7, groupId: 3, description: "Rent" });

    await allOperations({ model: "Expense", operation: "create", args: { data: { description: "Rent" } }, query });
    await flushAudit();

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toMatchObject({
      data: [{ entityType: "Expense", entityId: "7", action: "CREATE", groupId: 3 }],
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});
