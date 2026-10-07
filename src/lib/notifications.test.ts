import { describe, it, expect, expectTypeOf, beforeAll, afterAll } from "vitest";
import { NotificationType as SchemaNotificationType } from "@/generated/prisma/enums";
import { groupByDay, isoWeek, notificationHref, NOTIFICATION_TYPES, type NotificationType } from "./notifications";

describe("notificationHref", () => {
  it.each([
    ["EXPENSE_NEW", "/expenses"],
    ["PAYMENT_RECEIVED", "/balances"],
    ["DEBT_REMINDER", "/balances"],
    ["RECURRING_DUE", "/recurring"],
  ] as const)("%s opens %s", (type, href) => {
    expect(notificationHref(type)).toBe(href);
  });

  it("the client type union matches the schema's NotificationType enum", () => {
    expectTypeOf<NotificationType>().toEqualTypeOf<SchemaNotificationType>();
  });

  it("the runtime list NOTIFICATION_TYPES holds exactly the schema enum's values", () => {
    expect([...NOTIFICATION_TYPES].sort()).toEqual(Object.values(SchemaNotificationType).sort());
  });
});

describe("groupByDay (browser-local calendar dates)", () => {
  // Local-time constructors keep these tests independent of the machine's timezone.
  const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
  const item = (id: string, date: Date) => ({ id, createdAt: date.toISOString() });
  const shape = (groups: { key: string; items: { id: string }[] }[]) =>
    groups.map((g) => [g.key, g.items.map((i) => i.id)]);

  it("splits around local midnight: just after midnight, 23:59 the day before is yesterday", () => {
    const now = at(2026, 10, 4, 0, 5);
    const items = [
      item("today-0001", at(2026, 10, 4, 0, 1)),
      item("yesterday-2359", at(2026, 10, 3, 23, 59)),
      item("yesterday-0000", at(2026, 10, 3, 0, 0)),
      item("earlier-2359", at(2026, 10, 2, 23, 59)),
    ];
    expect(shape(groupByDay(items, now))).toEqual([
      ["today", ["today-0001"]],
      ["yesterday", ["yesterday-2359", "yesterday-0000"]],
      ["earlier", ["earlier-2359"]],
    ]);
  });

  it("just before midnight, everything since 00:00 is still today", () => {
    const now = at(2026, 10, 4, 23, 59);
    const items = [item("a", at(2026, 10, 4, 23, 58)), item("b", at(2026, 10, 4, 0, 0)), item("c", at(2026, 10, 3, 23, 59))];
    expect(shape(groupByDay(items, now))).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
    ]);
  });

  it("yesterday crosses month and year boundaries", () => {
    expect(shape(groupByDay([item("dec31", at(2026, 12, 31, 23, 50)), item("dec30", at(2026, 12, 30))], at(2027, 1, 1, 0, 10))))
      .toEqual([["yesterday", ["dec31"]], ["earlier", ["dec30"]]]);
    expect(shape(groupByDay([item("feb28", at(2026, 2, 28))], at(2026, 3, 1, 8)))).toEqual([["yesterday", ["feb28"]]]);
  });

  it("keeps the input order inside each group, orders the groups and omits empty ones", () => {
    const now = at(2026, 10, 4);
    const items = [
      item("t1", at(2026, 10, 4, 11)),
      item("e1", at(2026, 9, 20)),
      item("t2", at(2026, 10, 4, 9)),
      item("e2", at(2026, 8, 1)),
    ];
    expect(shape(groupByDay(items, now))).toEqual([
      ["today", ["t1", "t2"]],
      ["earlier", ["e1", "e2"]],
    ]);
    expect(groupByDay([], now)).toEqual([]);
  });

  it("a notice stamped slightly after the browser's now (clock skew) is today", () => {
    const now = at(2026, 10, 4, 23, 59);
    expect(shape(groupByDay([item("skew", at(2026, 10, 5, 0, 1))], now))).toEqual([["today", ["skew"]]]);
  });

  describe("across a DST change (EST5EDT: clocks go forward on 2026-03-08)", () => {
    // POSIX zone on purpose: Node on Windows ignores IANA names in TZ but honours EST5EDT.
    const originalTz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "EST5EDT";
    });
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it("yesterday is the previous calendar day, not now − 24 h (a 23-hour day)", () => {
      const now = at(2026, 3, 9, 0, 30);
      // now − 24 h lands on 2026-03-07 23:30 local: a 24-hour implementation would call this "earlier".
      expect(now.getTime() - at(2026, 3, 8, 0, 10).getTime()).toBeLessThan(86_400_000);
      expect(shape(groupByDay([item("mar8", at(2026, 3, 8, 0, 10))], now))).toEqual([["yesterday", ["mar8"]]]);
    });
  });
});

describe("isoWeek (UTC)", () => {
  it.each([
    ["2026-10-05T12:00:00Z", "2026-W41"], // the design's example (a Monday)
    ["2026-10-11T12:00:00Z", "2026-W41"], // Sunday closes the same week
    ["2026-10-12T00:00:00Z", "2026-W42"], // next Monday opens the next one
    ["2026-12-31T12:00:00Z", "2026-W53"], // 2026 starts on a Thursday → 53 weeks
    ["2027-01-01T12:00:00Z", "2026-W53"], // January days before the first Thursday's week belong to the old year
    ["2027-01-03T12:00:00Z", "2026-W53"],
    ["2027-01-04T12:00:00Z", "2027-W01"],
    ["2025-12-29T12:00:00Z", "2026-W01"], // late-December days can belong to the next year
    ["2026-01-01T12:00:00Z", "2026-W01"],
    ["2024-12-30T12:00:00Z", "2025-W01"],
    ["2021-01-03T12:00:00Z", "2020-W53"],
    ["2020-12-31T12:00:00Z", "2020-W53"], // leap year starting on a Wednesday → 53 weeks
  ])("%s → %s", (iso, week) => {
    expect(isoWeek(new Date(iso))).toBe(week);
  });

  it("uses the UTC calendar date, not the machine's local one", () => {
    expect(isoWeek(new Date("2027-01-03T23:59:59.999Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00.000Z"))).toBe("2027-W01");
  });
});
