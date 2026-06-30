import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    settlement: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    platform: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn(), count: vi.fn() },
    expense: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { settlementService } from "@/services/settlement.service";
import { platformService } from "@/services/platform.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettlementService — group scoping + persisted shape", () => {
  it("persists the payment scoped to the group", async () => {
    mockPrisma.settlement.create.mockResolvedValue({ id: 1 });
    await settlementService.create(7, { fromUserId: 2, toUserId: 1, amount: 50, note: "PIX" });
    const data = mockPrisma.settlement.create.mock.calls.at(-1)![0].data;
    expect(data).toMatchObject({ groupId: 7, fromUserId: 2, toUserId: 1, amount: 50, note: "PIX" });
  });

  it("delete throws ApiError 404 when the payment is not in the group", async () => {
    mockPrisma.settlement.findFirst.mockResolvedValue(null);
    await expect(settlementService.delete(1, "missing-uuid")).rejects.toMatchObject({ status: 404 });
    expect(mockPrisma.settlement.delete).not.toHaveBeenCalled();
  });
});

describe("PlatformService.delete — guards", () => {
  it("throws 404 when the platform to delete is not in the group", async () => {
    mockPrisma.platform.findFirst.mockResolvedValue(null); // findByPublicId → not found
    await expect(platformService.delete(1, "gone")).rejects.toMatchObject({ status: 404 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
