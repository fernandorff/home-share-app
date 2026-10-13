import { describe, it, expect } from "vitest";
import { isValidTimeZone } from "@/lib/recurrence";
import {
  browserTimeZone,
  buildRuleBody,
  closesOnError,
  dayHintKey,
  dueDateLabel,
  equalShareCents,
  fieldForErrorCode,
  monthName,
  parseDayInput,
  previewFirstPosting,
  previewPostingKey,
  ruleFormDirty,
  ruleStatus,
  shareMembers,
  stepDay,
  upcomingAcrossRules,
} from "@/lib/recurring-view";
import type { RuleFormValues } from "@/lib/recurring-view";
import type { Member, RecurringExpense } from "@/lib/types";

const member = (id: number, active = true): Member => ({
  id,
  publicId: `m${id}`,
  name: `Member ${id}`,
  username: `m${id}`,
  role: "MEMBER",
  colorIndex: id,
  active,
  deleted: false,
});

function rule(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
  return {
    publicId: "r1",
    description: "Rent",
    amount: "1800.00",
    dayOfMonth: 5,
    payerId: 1,
    splitMode: "ALL",
    participantIds: [],
    timezone: "America/Sao_Paulo",
    activeFrom: "2026-10-01",
    paused: false,
    pauseReason: null,
    skippedPeriods: [],
    lastClosedPeriod: null,
    upcoming: [],
    canManage: true,
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("day stepper", () => {
  it("steps within 1–31", () => {
    expect(stepDay(5, 1)).toBe(6);
    expect(stepDay(5, -1)).toBe(4);
    expect(stepDay(1, -1)).toBe(1);
    expect(stepDay(31, 1)).toBe(31);
  });

  it("accepts a typed day only from 1 to 31", () => {
    expect(parseDayInput("15")).toBe(15);
    expect(parseDayInput("07")).toBe(7);
    expect(parseDayInput("31")).toBe(31);
    expect(parseDayInput("0")).toBeNull();
    expect(parseDayInput("32")).toBeNull();
    expect(parseDayInput("")).toBeNull();
    expect(parseDayInput("1a")).toBeNull();
  });

  it("explains the last-day clamp only above day 28", () => {
    expect(dayHintKey(1)).toBe("form.dayHintWeekend");
    expect(dayHintKey(28)).toBe("form.dayHintWeekend");
    expect(dayHintKey(29)).toBe("form.dayHintClamp");
    expect(dayHintKey(31)).toBe("form.dayHintClamp");
  });
});

describe("browserTimeZone", () => {
  it("returns a zone the server accepts", () => {
    expect(isValidTimeZone(browserTimeZone())).toBe(true);
  });
});

describe("previewFirstPosting (criterion 22)", () => {
  it("new rule: the first due date on or after today", () => {
    expect(previewFirstPosting({ dayOfMonth: 5, today: "2026-10-03" })).toBe("2026-10-05");
    expect(previewFirstPosting({ dayOfMonth: 2, today: "2026-10-03" })).toBe("2026-11-02");
  });

  it("new rule due today: posts today (the create posts it right away)", () => {
    expect(previewFirstPosting({ dayOfMonth: 3, today: "2026-10-03" })).toBe("2026-10-03");
  });

  it("clamps 29–31 to the month's last day", () => {
    expect(previewFirstPosting({ dayOfMonth: 31, today: "2026-11-10" })).toBe("2026-11-30");
    expect(previewFirstPosting({ dayOfMonth: 30, today: "2027-02-01" })).toBe("2027-02-28");
    expect(previewFirstPosting({ dayOfMonth: 31, today: "2028-02-01" })).toBe("2028-02-29");
  });

  it("edit moving the day before today in a month not yet posted: that month posts now, on its due date", () => {
    expect(
      previewFirstPosting({ dayOfMonth: 5, today: "2026-10-10", activeFrom: "2026-09-01", lastClosedPeriod: "2026-09" })
    ).toBe("2026-10-05");
  });

  it("edit of a rule already posted this month: next month", () => {
    expect(
      previewFirstPosting({ dayOfMonth: 20, today: "2026-10-10", activeFrom: "2026-09-01", lastClosedPeriod: "2026-10" })
    ).toBe("2026-11-20");
  });

  it("jumps over skipped months", () => {
    expect(
      previewFirstPosting({
        dayOfMonth: 20,
        today: "2026-10-25",
        activeFrom: "2026-09-01",
        lastClosedPeriod: "2026-10",
        skippedPeriods: ["2026-11"],
      })
    ).toBe("2026-12-20");
    // A skipped month that is already due is not the first posting either.
    expect(
      previewFirstPosting({ dayOfMonth: 5, today: "2026-10-10", activeFrom: "2026-09-01", lastClosedPeriod: "2026-09", skippedPeriods: ["2026-10"] })
    ).toBe("2026-11-05");
  });
});

describe("equalShareCents", () => {
  it("the base share of the integer-cents split (the leftover cents go to the first people)", () => {
    expect(equalShareCents(10000, 3)).toBe(3333);
    expect(equalShareCents(180000, 4)).toBe(45000);
  });

  it("null without an amount or without people", () => {
    expect(equalShareCents(0, 3)).toBeNull();
    expect(equalShareCents(10000, 0)).toBeNull();
  });
});

describe("ruleStatus (rule card status line)", () => {
  const everyone = new Set([1, 2, 3]);

  it("paused because the payer left: Edit, not Resume", () => {
    expect(ruleStatus(rule({ paused: true, pauseReason: "MEMBER_LEFT", payerId: 9 }), everyone)).toEqual({ kind: "memberLeft" });
  });

  it("paused because a selected participant left", () => {
    const r = rule({ paused: true, pauseReason: "MEMBER_LEFT", payerId: 1, splitMode: "SELECTED", participantIds: [2, 9] });
    expect(ruleStatus(r, everyone)).toEqual({ kind: "memberLeft" });
  });

  it("member-left pause after an edit replaced the people: a plain pause, so Resume is offered", () => {
    expect(ruleStatus(rule({ paused: true, pauseReason: "MEMBER_LEFT", payerId: 1 }), everyone)).toEqual({ kind: "paused" });
  });

  it("ALL split ignores stale participantIds of inactive people", () => {
    const r = rule({ paused: true, pauseReason: "MEMBER_LEFT", payerId: 1, splitMode: "ALL", participantIds: [9] });
    expect(ruleStatus(r, everyone)).toEqual({ kind: "paused" });
  });

  it("member list not loaded (or failed): a plain pause, the server re-validates on Resume", () => {
    expect(ruleStatus(rule({ paused: true, pauseReason: "MEMBER_LEFT", payerId: 9 }), new Set())).toEqual({ kind: "paused" });
  });

  it("paused by a member", () => {
    expect(ruleStatus(rule({ paused: true, pauseReason: "MANUAL" }), everyone)).toEqual({ kind: "paused" });
  });

  it("next month skipped: back in the first month that is not", () => {
    const upcoming = [
      { period: "2026-11", dueOn: "2026-11-05", skipped: true },
      { period: "2026-12", dueOn: "2026-12-05", skipped: true },
      { period: "2027-01", dueOn: "2027-01-05", skipped: false },
    ];
    expect(ruleStatus(rule({ upcoming }), everyone)).toEqual({ kind: "skipped", backIn: "2027-01" });
  });

  it("every upcoming month skipped: no 'back in'", () => {
    const upcoming = [{ period: "2026-11", dueOn: "2026-11-05", skipped: true }];
    expect(ruleStatus(rule({ upcoming }), everyone)).toEqual({ kind: "skipped", backIn: null });
  });

  it("next posting", () => {
    const upcoming = [{ period: "2026-11", dueOn: "2026-11-05", skipped: false }];
    expect(ruleStatus(rule({ upcoming }), everyone)).toEqual({ kind: "next", dueOn: "2026-11-05" });
  });

  it("nothing upcoming", () => {
    expect(ruleStatus(rule(), everyone)).toEqual({ kind: "none" });
  });
});

describe("upcomingAcrossRules (Upcoming tab)", () => {
  const a = rule({
    publicId: "a",
    upcoming: [
      { period: "2026-10", dueOn: "2026-10-10", skipped: false },
      { period: "2026-11", dueOn: "2026-11-10", skipped: true },
      { period: "2026-12", dueOn: "2026-12-10", skipped: false },
    ],
  });
  const b = rule({
    publicId: "b",
    upcoming: [
      { period: "2026-10", dueOn: "2026-10-05", skipped: false },
      { period: "2026-11", dueOn: "2026-11-05", skipped: false },
      { period: "2026-12", dueOn: "2026-12-05", skipped: false },
    ],
  });
  const c = rule({
    publicId: "c",
    upcoming: [{ period: "2026-10", dueOn: "2026-10-10", skipped: false }],
  });

  it("flattens every rule's next periods by due date, ties in rule order, at most 6", () => {
    const rows = upcomingAcrossRules([a, b, c]);
    expect(rows.map((r) => `${r.rule.publicId}:${r.dueOn}`)).toEqual([
      "b:2026-10-05",
      "a:2026-10-10",
      "c:2026-10-10",
      "b:2026-11-05",
      "a:2026-11-10",
      "b:2026-12-05",
    ]);
    expect(rows[4].skipped).toBe(true);
  });

  it("a paused rule has no upcoming periods", () => {
    expect(upcomingAcrossRules([rule({ paused: true })])).toEqual([]);
  });
});

describe("shareMembers", () => {
  const members = [member(1), member(2), member(3, false)];

  it("ALL: every active member", () => {
    const { people, count } = shareMembers(rule(), members);
    expect(people.map((m) => m.id)).toEqual([1, 2]);
    expect(count).toBe(2);
  });

  it("SELECTED: the rule's people in its order, ex-members included", () => {
    const { people, count } = shareMembers(rule({ splitMode: "SELECTED", participantIds: [3, 1] }), members);
    expect(people.map((m) => m.id)).toEqual([3, 1]);
    expect(count).toBe(2);
  });

  it("SELECTED: the count stays the rule's even if a member is unknown to the client", () => {
    expect(shareMembers(rule({ splitMode: "SELECTED", participantIds: [1, 99] }), members).count).toBe(2);
  });
});

describe("date and month labels", () => {
  it("a due date reads DD/MM/YYYY and never drifts a day with the viewer's timezone", () => {
    expect(dueDateLabel("2026-11-05")).toBe("05/11/2026");
    expect(dueDateLabel("2027-01-01")).toBe("01/01/2027");
  });

  it("month names in the viewer's language", () => {
    expect(monthName("2026-11", "en")).toBe("November");
    expect(monthName("2026-11", "pt")).toBe("novembro");
    expect(monthName("2027-01", "es")).toBe("enero");
    expect(monthName("2026-11", "en", "short")).toBe("Nov");
  });
});

describe("fieldForErrorCode (U11: the error under the field it is about)", () => {
  it.each([
    ["DESCRIPTION_REQUIRED", "description"],
    ["DESCRIPTION_TOO_LONG", "description"],
    ["DESCRIPTION_INVALID", "description"],
    ["AMOUNT_INVALID", "amount"],
    ["AMOUNT_PRECISION", "amount"],
    ["AMOUNT_TOO_HIGH", "amount"],
    ["RECURRING_DAY_INVALID", "day"],
    ["PAYER_REQUIRED", "payer"],
    ["RECURRING_SPLIT_INVALID", "split"],
  ] as const)("%s → %s", (code, field) => {
    expect(fieldForErrorCode(code)).toBe(field);
  });

  it("form-level codes stay in the footer", () => {
    for (const code of ["STALE_RECURRING_EXPENSE", "RECURRING_MEMBER_INACTIVE", "RECURRING_LIMIT_REACHED", "STALE_GROUP", undefined]) {
      expect(fieldForErrorCode(code)).toBeNull();
    }
  });
});

// Item 14 (cycle F review): the request bodies the form sends, as behavior instead of source strings.
describe("buildRuleBody (what the rule form sends)", () => {
  const values = { description: "  Rent  ", amountCents: 180000, day: 5, payerId: "3", splitMode: "ALL" as const, picked: [1, 2, 3] };

  it("create: the fields, the browser's timezone and the house guard — no lock token", () => {
    const body = buildRuleBody(values, { mode: "create", groupId: 7, timezone: "America/Sao_Paulo" });
    expect(body).toEqual({
      description: "Rent",
      amount: 1800,
      dayOfMonth: 5,
      payerId: 3,
      splitMode: "ALL",
      expectedGroupId: 7,
      timezone: "America/Sao_Paulo",
    });
    expect(body).not.toHaveProperty("expectedUpdatedAt");
    expect(body).not.toHaveProperty("paused");
  });

  it("participantIds only for SELECTED, in the order picked (the leftover cents go to the first people)", () => {
    expect(buildRuleBody(values, { mode: "create", groupId: 7, timezone: "UTC" })).not.toHaveProperty("participantIds");
    const selected = buildRuleBody({ ...values, splitMode: "SELECTED", picked: [3, 1] }, { mode: "create", groupId: 7, timezone: "UTC" });
    expect(selected.participantIds).toEqual([3, 1]);
  });

  it("edit: the fields, the optimistic-lock token and the house guard — never `paused`, never `timezone`", () => {
    const body = buildRuleBody({ ...values, splitMode: "SELECTED", picked: [2] }, { mode: "edit", groupId: 7, lockToken: "2026-10-01T12:00:00.000Z" });
    expect(body).toEqual({
      description: "Rent",
      amount: 1800,
      dayOfMonth: 5,
      payerId: 3,
      splitMode: "SELECTED",
      participantIds: [2],
      expectedGroupId: 7,
      expectedUpdatedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(body).not.toHaveProperty("paused");
    expect(body).not.toHaveProperty("timezone");
  });

  it("the amount leaves as reais from integer cents (no float drift)", () => {
    expect(buildRuleBody({ ...values, amountCents: 10 }, { mode: "create", groupId: 1, timezone: "UTC" }).amount).toBe(0.1);
    expect(buildRuleBody({ ...values, amountCents: 9999999999 }, { mode: "create", groupId: 1, timezone: "UTC" }).amount).toBe(99999999.99);
  });
});

// Item 3: closing a filled form asks first (same guard as the expense form, BL-14/U9).
describe("ruleFormDirty (unsaved-changes guard)", () => {
  const opened: RuleFormValues = {
    description: "Rent",
    amountMasked: "1.800,00",
    day: 5,
    dayText: "5",
    payerId: "1",
    splitMode: "ALL",
    picked: [1, 2],
  };

  it("untouched (or typed and reverted): not dirty", () => {
    expect(ruleFormDirty(opened, { ...opened })).toBe(false);
    expect(ruleFormDirty(opened, { ...opened, picked: [...opened.picked] })).toBe(false);
  });

  it.each([
    ["description", { description: "Rent 2" }],
    ["amount", { amountMasked: "1.900,00" }],
    ["day", { day: 6, dayText: "6" }],
    ["payer", { payerId: "2" }],
    ["split mode", { splitMode: "SELECTED" as const }],
  ])("a changed %s is dirty", (_, change) => {
    expect(ruleFormDirty(opened, { ...opened, ...change })).toBe(true);
  });

  it("the people only count while choosing people (ALL ignores the hidden list)", () => {
    const selected: RuleFormValues = { ...opened, splitMode: "SELECTED", picked: [1, 2] };
    expect(ruleFormDirty(selected, { ...selected, picked: [1] })).toBe(true);
    // Same people in another order: another request (the order decides who gets the leftover cents).
    expect(ruleFormDirty(selected, { ...selected, picked: [2, 1] })).toBe(true);
    expect(ruleFormDirty(opened, { ...opened, picked: [1] })).toBe(false);
  });

  it("a day box mid-typing (empty) is not a change by itself", () => {
    expect(ruleFormDirty(opened, { ...opened, dayText: "" })).toBe(false);
  });
});

// Item 4: the preview's posting line.
describe("previewPostingKey (form preview)", () => {
  it("new rule: first posting", () => expect(previewPostingKey(null)).toBe("form.firstPosting"));
  it("editing an active rule: next posting", () => expect(previewPostingKey(rule())).toBe("form.nextPosting"));
  it("editing a paused rule (by a member or because someone left): no date — nothing is posted until resumed", () => {
    expect(previewPostingKey(rule({ paused: true, pauseReason: "MANUAL" }))).toBeNull();
    expect(previewPostingKey(rule({ paused: true, pauseReason: "MEMBER_LEFT" }))).toBeNull();
  });
});

// Item 5: a rule deleted elsewhere (404) or no longer the viewer's to manage (403) — retrying cannot work.
describe("closesOnError", () => {
  it("closes the dialog when the rule is gone or out of the viewer's hands", () => {
    expect(closesOnError("RECURRING_NOT_FOUND")).toBe(true);
    expect(closesOnError("NOT_RECURRING_OWNER")).toBe(true);
  });

  it("keeps it open for everything the viewer can fix or retry", () => {
    for (const code of ["STALE_RECURRING_EXPENSE", "RECURRING_MEMBER_INACTIVE", "AMOUNT_INVALID", "STALE_GROUP", undefined]) {
      expect(closesOnError(code)).toBe(false);
    }
  });
});
