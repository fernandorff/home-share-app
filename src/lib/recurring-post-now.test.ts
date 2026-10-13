import { describe, it, expect, vi, beforeEach } from "vitest";

// The service is faked: this file only pins the helper's contract. What postDue writes is asserted by
// recurring-expense.service.test.ts and tenant-isolation.test.ts.
const { mockPostDue, mockGet, mockError } = vi.hoisted(() => ({ mockPostDue: vi.fn(), mockGet: vi.fn(), mockError: vi.fn() }));
vi.mock("@/services/recurring-expense.service", () => ({ recurringExpenseService: { postDue: mockPostDue, get: mockGet } }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mockError } }));

import { postRuleNow } from "./recurring-post-now";
import type { RecurringExpenseDto } from "@/services/recurring-expense.service";

const NOW = new Date("2026-10-05T11:30:00.000Z");
const viewer = { userId: 1, role: "MEMBER" as const };
const NO_RUN = { posted: 0, skipped: 0, paused: 0, duplicates: 0, failed: 0, remaining: 0 };
const saved = { id: 42, rule: { publicId: "rule-public-id", description: "Rent" } as RecurringExpenseDto };
const reloaded = { publicId: "rule-public-id", description: "Rent", lastClosedPeriod: "2026-10" } as RecurringExpenseDto;

beforeEach(() => {
  vi.resetAllMocks();
  mockPostDue.mockResolvedValue(NO_RUN);
  mockGet.mockResolvedValue(reloaded);
});

describe("postRuleNow — post that rule now, then re-read it when the run changed anything", () => {
  it("runs postDue for that rule only, with the caller's clock", async () => {
    await postRuleNow(7, viewer, saved, NOW);

    expect(mockPostDue).toHaveBeenCalledTimes(1);
    expect(mockPostDue).toHaveBeenCalledWith(NOW, { recurringExpenseId: 42 });
  });

  it("returns the saved rule untouched, with postedNow 0, when the run did nothing", async () => {
    const result = await postRuleNow(7, viewer, saved, NOW);

    expect(result).toEqual({ rule: saved.rule, postedNow: 0 });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("failed or remaining alone changed nothing: no re-read", async () => {
    mockPostDue.mockResolvedValue({ ...NO_RUN, failed: 1, remaining: 1 });

    const result = await postRuleNow(7, viewer, saved, NOW);

    expect(result).toEqual({ rule: saved.rule, postedNow: 0 });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it.each(["posted", "skipped", "paused", "duplicates"] as const)(
    "re-reads the rule for the same house, viewer and clock when the run counted %s",
    async (counter) => {
      mockPostDue.mockResolvedValue({ ...NO_RUN, [counter]: 1 });

      const result = await postRuleNow(7, viewer, saved, NOW);

      expect(mockGet).toHaveBeenCalledWith(7, viewer, "rule-public-id", NOW);
      expect(result.rule).toBe(reloaded);
      expect(result.postedNow).toBe(counter === "posted" ? 1 : 0);
    }
  );

  it("never throws when postDue fails after the rule was saved: logs it and returns the saved rule with postedNow 0", async () => {
    mockPostDue.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await postRuleNow(7, viewer, saved, NOW);

    expect(result).toEqual({ rule: saved.rule, postedNow: 0 });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][1]).toEqual({ recurringExpenseId: 42 });
  });

  it("never throws when the re-read fails: logs it and returns the saved rule, keeping the posting it already counted", async () => {
    mockPostDue.mockResolvedValue({ ...NO_RUN, posted: 1 });
    mockGet.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const result = await postRuleNow(7, viewer, saved, NOW);

    expect(result).toEqual({ rule: saved.rule, postedNow: 1 });
    expect(mockError).toHaveBeenCalledTimes(1);
  });
});
