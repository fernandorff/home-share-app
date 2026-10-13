import { describe, expect, it } from "vitest";
import {
  addMonths,
  dueOn,
  eligiblePeriods,
  isValidPeriod,
  isValidTimeZone,
  localToday,
  periodOf,
  upcomingPeriods,
} from "./recurrence";

describe("isValidPeriod — YYYY-MM with a real month", () => {
  it("accepts every month of a year, including the edges", () => {
    for (const month of ["01", "02", "09", "10", "11", "12"]) expect(isValidPeriod(`2026-${month}`)).toBe(true);
    expect(isValidPeriod("0001-01")).toBe(true);
    expect(isValidPeriod("9999-12")).toBe(true);
  });

  it("rejects month 00 and 13+, short or long forms, a day, other separators, whitespace and the empty string", () => {
    for (const bad of ["2026-00", "2026-13", "2026-1", "26-11", "2026-011", "2026-11-05", "2026/11", "202611", "2026-11 ", " 2026-11", "2026-11\n", "november", ""]) {
      expect(isValidPeriod(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects anything that is not a string", () => {
    for (const bad of [undefined, null, 202611, ["2026-11"], { period: "2026-11" }]) expect(isValidPeriod(bad)).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones Intl knows", () => {
    expect(isValidTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects unknown zones, empty strings, non-strings and anything over 64 chars", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(-3)).toBe(false);
    expect(isValidTimeZone(`America/${"X".repeat(60)}`)).toBe(false);
  });
});

describe("localToday — the calendar date in the rule's zone, never the server's (criterion 5)", () => {
  it("02:30 UTC is still the previous day in São Paulo and Honolulu, already the same day in Tokyo", () => {
    const now = new Date("2026-10-05T02:30:00Z");
    expect(localToday("America/Sao_Paulo", now)).toBe("2026-10-04");
    expect(localToday("Pacific/Honolulu", now)).toBe("2026-10-04");
    expect(localToday("Asia/Tokyo", now)).toBe("2026-10-05");
  });

  it("03:00 UTC is midnight in São Paulo: the local day turns", () => {
    const now = new Date("2026-10-05T03:00:00Z");
    expect(localToday("America/Sao_Paulo", now)).toBe("2026-10-05");
    expect(localToday("Pacific/Honolulu", now)).toBe("2026-10-04");
  });

  it("00:00 UTC and 23:30 UTC around the Tokyo day boundary", () => {
    expect(localToday("Asia/Tokyo", new Date("2026-10-04T23:30:00Z"))).toBe("2026-10-05");
    expect(localToday("Pacific/Honolulu", new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-04");
    expect(localToday("UTC", new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-05");
  });
});

describe("periodOf / addMonths — YYYY-MM arithmetic", () => {
  it("periodOf takes the month of a YYYY-MM-DD date", () => {
    expect(periodOf("2026-10-04")).toBe("2026-10");
  });

  it("addMonths crosses year boundaries both ways and keeps zero padding", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-10", 14)).toBe("2027-12");
    expect(addMonths("2026-03", 0)).toBe("2026-03");
  });
});

describe("dueOn — day clamped to the month's last day; weekends never move it (criterion 5)", () => {
  it("keeps a day every month has", () => {
    expect(dueOn("2026-01", 5)).toBe("2026-01-05");
    // 2026-10-10 is a Saturday: it stays put.
    expect(dueOn("2026-10", 10)).toBe("2026-10-10");
  });

  it("31 → 30 April; 29/30/31 → 28 February, 29 in a leap year", () => {
    expect(dueOn("2026-04", 31)).toBe("2026-04-30");
    expect(dueOn("2027-02", 31)).toBe("2027-02-28");
    expect(dueOn("2027-02", 29)).toBe("2027-02-28");
    expect(dueOn("2028-02", 30)).toBe("2028-02-29");
    expect(dueOn("2026-03", 31)).toBe("2026-03-31");
  });
});

describe("eligiblePeriods — periods to post, oldest first (criteria 6, 7)", () => {
  it("a rule created mid-month after its day never back-fills that month", () => {
    const rule = { activeFrom: "2026-10-10", dayOfMonth: 5 };
    expect(eligiblePeriods(rule, "2026-10-10", null)).toEqual([]);
    expect(eligiblePeriods(rule, "2026-11-04", null)).toEqual([]);
    expect(eligiblePeriods(rule, "2026-11-05", null)).toEqual(["2026-11"]);
  });

  it("a rule created on or before its day in the month posts that month once the day arrives", () => {
    expect(eligiblePeriods({ activeFrom: "2026-10-05", dayOfMonth: 5 }, "2026-10-05", null)).toEqual(["2026-10"]);
    expect(eligiblePeriods({ activeFrom: "2026-10-01", dayOfMonth: 20 }, "2026-10-19", null)).toEqual([]);
    expect(eligiblePeriods({ activeFrom: "2026-10-01", dayOfMonth: 20 }, "2026-10-20", null)).toEqual(["2026-10"]);
  });

  it("catches up every missed month after the last closed period", () => {
    const rule = { activeFrom: "2026-01-01", dayOfMonth: 10 };
    expect(eligiblePeriods(rule, "2026-05-10", "2026-01")).toEqual(["2026-02", "2026-03", "2026-04", "2026-05"]);
    expect(eligiblePeriods(rule, "2026-05-09", "2026-04")).toEqual([]);
  });

  it("caps the catch-up at 12 periods (oldest first), or at a custom max", () => {
    const rule = { activeFrom: "2024-01-01", dayOfMonth: 1 };
    const all = eligiblePeriods(rule, "2026-10-04", null);
    expect(all).toHaveLength(12);
    expect(all[0]).toBe("2024-01");
    expect(all[11]).toBe("2024-12");
    expect(eligiblePeriods(rule, "2026-10-04", null, 2)).toEqual(["2024-01", "2024-02"]);
  });

  it("a paused-then-resumed rule restarts at the resume date: the months it was paused are never posted", () => {
    // Day 5, last posted for June, paused, resumed on Sept 10 (activeFrom reset).
    const resumed = { activeFrom: "2026-09-10", dayOfMonth: 5 };
    expect(eligiblePeriods(resumed, "2026-09-10", "2026-06")).toEqual([]);
    expect(eligiblePeriods(resumed, "2026-10-05", "2026-06")).toEqual(["2026-10"]);
  });

  it("uses the clamped due date (day 31 in February)", () => {
    const rule = { activeFrom: "2027-02-01", dayOfMonth: 31 };
    expect(eligiblePeriods(rule, "2027-02-27", null)).toEqual([]);
    expect(eligiblePeriods(rule, "2027-02-28", null)).toEqual(["2027-02"]);
  });
});

describe("upcomingPeriods — next due dates without a ledger row (criteria 1, 15)", () => {
  const rule = { dayOfMonth: 10, paused: false, skippedPeriods: [] as string[] };

  it("lists the next 3 due dates from today, today included", () => {
    expect(upcomingPeriods(rule, "2026-10-10", null)).toEqual([
      { period: "2026-10", dueOn: "2026-10-10", skipped: false },
      { period: "2026-11", dueOn: "2026-11-10", skipped: false },
      { period: "2026-12", dueOn: "2026-12-10", skipped: false },
    ]);
    expect(upcomingPeriods(rule, "2026-10-11", null).map((u) => u.period)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("starts after the last closed period (a month with a ledger row is never upcoming)", () => {
    // Posted for October on the 5th, then the day was moved to the 25th: October is closed.
    const moved = { ...rule, dayOfMonth: 25 };
    expect(upcomingPeriods(moved, "2026-10-10", "2026-10").map((u) => u.period)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });

  it("flags skipped periods and keeps them in the list", () => {
    const skipping = { ...rule, skippedPeriods: ["2026-11"] };
    expect(upcomingPeriods(skipping, "2026-10-11", null)).toEqual([
      { period: "2026-11", dueOn: "2026-11-10", skipped: true },
      { period: "2026-12", dueOn: "2026-12-10", skipped: false },
      { period: "2027-01", dueOn: "2027-01-10", skipped: false },
    ]);
  });

  it("returns n periods with clamped due dates", () => {
    const end = { ...rule, dayOfMonth: 31 };
    expect(upcomingPeriods(end, "2027-01-31", null, 2)).toEqual([
      { period: "2027-01", dueOn: "2027-01-31", skipped: false },
      { period: "2027-02", dueOn: "2027-02-28", skipped: false },
    ]);
  });

  it("is empty while paused", () => {
    expect(upcomingPeriods({ ...rule, paused: true }, "2026-10-10", null)).toEqual([]);
  });
});
