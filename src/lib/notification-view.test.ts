import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import { groupByDay, NOTIFICATION_LIST_LIMIT, NOTIFICATION_TYPES } from "@/lib/notifications";
import { formatDateLocale } from "@/lib/money";
import {
  answeredForOtherHouse,
  badgeText,
  focusAfterRemove,
  installBannerVisible,
  installCardState,
  installSheetAndroid,
  installUnsupported,
  isFullList,
  markAllNoticesRead,
  memberDisplayName,
  noticeMessage,
  noticePersonId,
  noticeTimeLabel,
  noticesPath,
  removeNotice,
  restoreNotice,
  restoreUnread,
  setNoticeRead,
  unreadIds,
  visibleNotices,
  type InstallEnv,
} from "@/lib/notification-view";
import type { AppNotification, Member } from "@/lib/types";

const member = (id: number, name: string, extra: Partial<Member> = {}): Member => ({
  id,
  publicId: `m${id}`,
  name,
  username: `u${id}`,
  role: "MEMBER",
  colorIndex: id,
  active: true,
  deleted: false,
  ...extra,
});

const MEMBERS: Member[] = [
  member(1, "Ana QA"),
  member(2, "Bruno QA"),
  member(3, "Carla Old", { active: false }),
  member(4, "Deleted 4", { active: false, deleted: true }),
];

const LABELS = {
  automatic: "Home Share",
  deleted: "Deleted user",
  exMember: (name: string) => `Ex-member: ${name}`,
  unknown: "—",
};

const base = { read: false, createdAt: "2026-10-04T12:00:00.000Z" };
const expenseNew = (overrides: Partial<{ actorId: number | null; recurring: boolean }> = {}): AppNotification => ({
  ...base,
  publicId: "n-expense",
  type: "EXPENSE_NEW",
  actorId: overrides.actorId === undefined ? 2 : overrides.actorId,
  params: { description: "Rent", amount: "60.00", recurring: overrides.recurring ?? false },
});
const paymentReceived: AppNotification = {
  ...base,
  publicId: "n-payment",
  type: "PAYMENT_RECEIVED",
  actorId: 1, // the member who recorded it
  params: { fromUserId: 2, amount: "10.00" }, // the payer
};
const debtReminder: AppNotification = {
  ...base,
  publicId: "n-debt",
  type: "DEBT_REMINDER",
  actorId: null,
  params: { amount: "45.90" },
};
const recurringDue: AppNotification = {
  ...base,
  publicId: "n-due",
  type: "RECURRING_DUE",
  actorId: null,
  params: { description: "Internet", amount: "119.90", dueOn: "2026-10-05" },
};
const SAMPLES: AppNotification[] = [expenseNew(), expenseNew({ actorId: null, recurring: true }), paymentReceived, debtReminder, recurringDue];

const fmt = {
  money: (amount: string) => `$${amount}`,
  name: (id: number | null) => memberDisplayName(id, MEMBERS, LABELS),
};

describe("isFullList (the limit notice)", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => ({ ...debtReminder, publicId: `n${i}` }));

  it("is true exactly when the server list holds NOTIFICATION_LIST_LIMIT (50) notices", () => {
    expect(NOTIFICATION_LIST_LIMIT).toBe(50);
    expect(isFullList(list(50))).toBe(true);
    expect(isFullList(list(49))).toBe(false);
    expect(isFullList([])).toBe(false);
  });

  it("the limit is defined once: the service's list bound reads the same constant", () => {
    const service = readFileSync(join(process.cwd(), "src/services/notification.service.ts"), "utf8");
    expect(service).toContain("LIST: NOTIFICATION_LIST_LIMIT,");
    expect(readFileSync(join(process.cwd(), "src/lib/notification-view.ts"), "utf8")).not.toMatch(/=\s*50\b/);
  });
});

describe("badgeText", () => {
  it("shows the count, capped at 99+ so the badge keeps its size", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
    expect(badgeText(1234)).toBe("99+");
  });
});

describe("noticesPath", () => {
  it("asks the API for unread notices only under the Unread filter", () => {
    expect(noticesPath("all")).toBe("/api/notifications");
    expect(noticesPath("unread")).toBe("/api/notifications?filter=unread");
  });
});

// Final review, minor 2: another tab switched the house, so the cookie (and the server's answer) moved while this
// tab still shows the previous house — its answer is dropped and the session re-read.
describe("answeredForOtherHouse (cross-tab house switch)", () => {
  it("an answer without a house (older API) is not a mismatch", () => {
    expect(answeredForOtherHouse(undefined, 7)).toBe(false);
  });

  it("true when the server answered for another house than the one on screen", () => {
    expect(answeredForOtherHouse(9, 7)).toBe(true);
  });

  it("false when the answer is for the house on screen", () => {
    expect(answeredForOtherHouse(7, 7)).toBe(false);
  });

  it("false while no house is on screen yet (nothing to compare with)", () => {
    expect(answeredForOtherHouse(7, null)).toBe(false);
    expect(answeredForOtherHouse(7, undefined)).toBe(false);
  });
});

describe("memberDisplayName (resolved exactly like Activity, criterion 16)", () => {
  it("an active member shows the current name", () => {
    expect(memberDisplayName(1, MEMBERS, LABELS)).toBe("Ana QA");
  });

  it("an ex-member keeps the name, tagged", () => {
    expect(memberDisplayName(3, MEMBERS, LABELS)).toBe("Ex-member: Carla Old");
  });

  it("a deleted account shows the translated label, never the scrubbed name", () => {
    expect(memberDisplayName(4, MEMBERS, LABELS)).toBe("Deleted user");
  });

  it("no actor = automatic (Home Share)", () => {
    expect(memberDisplayName(null, MEMBERS, LABELS)).toBe("Home Share");
  });

  it("an id not in the house's list (members still loading) gets the neutral placeholder", () => {
    expect(memberDisplayName(99, MEMBERS, LABELS)).toBe("—");
    expect(memberDisplayName(1, [], LABELS)).toBe("—");
  });
});

describe("noticePersonId (whose avatar a notice shows)", () => {
  it("a new expense shows its author", () => {
    expect(noticePersonId(expenseNew())).toBe(2);
  });

  it("a payment shows the payer, not the member who recorded it", () => {
    expect(noticePersonId(paymentReceived)).toBe(2);
  });

  it("automatic notices have no person (↻ glyph)", () => {
    expect(noticePersonId(expenseNew({ actorId: null, recurring: true }))).toBeNull();
    expect(noticePersonId(debtReminder)).toBeNull();
    expect(noticePersonId(recurringDue)).toBeNull();
  });

  it("a payment row without a payer id falls back to the actor", () => {
    const legacy = { ...paymentReceived, params: { amount: "10.00" } } as unknown as AppNotification;
    expect(noticePersonId(legacy)).toBe(1);
  });
});

describe("noticeMessage (text per type, amounts through the house formatter)", () => {
  it("new expense: actor, description and amount", () => {
    expect(noticeMessage(expenseNew(), fmt)).toEqual({
      key: "text.EXPENSE_NEW",
      values: { actor: "Bruno QA", description: "Rent", amount: "$60.00" },
    });
  });

  it("recurring posting: the 'posted automatically' text, with no actor", () => {
    expect(noticeMessage(expenseNew({ actorId: null, recurring: true }), fmt)).toEqual({
      key: "text.EXPENSE_NEW_RECURRING",
      values: { description: "Rent", amount: "$60.00" },
    });
  });

  it("the recurring flag decides, not a missing actor", () => {
    expect(noticeMessage(expenseNew({ actorId: null, recurring: false }), fmt).key).toBe("text.EXPENSE_NEW");
  });

  it("payment received names the payer (params.fromUserId), not the recorder", () => {
    expect(noticeMessage(paymentReceived, fmt)).toEqual({
      key: "text.PAYMENT_RECEIVED",
      values: { payer: "Bruno QA", amount: "$10.00" },
    });
  });

  it("debt reminder and due-date reminder", () => {
    expect(noticeMessage(debtReminder, fmt)).toEqual({ key: "text.DEBT_REMINDER", values: { amount: "$45.90" } });
    expect(noticeMessage(recurringDue, fmt)).toEqual({
      key: "text.RECURRING_DUE",
      values: { description: "Internet", amount: "$119.90" },
    });
  });

  it("covers every NotificationType", () => {
    expect(new Set(SAMPLES.map((n) => n.type))).toEqual(new Set(NOTIFICATION_TYPES));
  });

  it.each([
    ["en", en],
    ["pt", pt],
  ] as const)("%s: every key exists and renders with exactly the values passed", (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: "Notifications" });
    const rendered = SAMPLES.map((n) => {
      const { key, values } = noticeMessage(n, fmt);
      return t(key, values);
    });
    expect(rendered[0]).toContain("Bruno QA");
    expect(rendered[0]).toContain("“Rent”");
    expect(rendered[0]).toContain("$60.00");
    expect(rendered[1]).not.toContain("Home Share");
    expect(rendered[2]).toContain("Bruno QA");
    expect(rendered[2]).not.toContain("Ana QA");
    expect(rendered[3]).toContain("$45.90");
    expect(rendered[4]).toContain("“Internet”");
    for (const text of rendered) expect(text).not.toMatch(/[{}]|Notifications\./);
  });
});

describe("noticeTimeLabel (relative time, consistent with the day groups)", () => {
  const rtf = (locale: string) => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const now = new Date(2026, 9, 4, 12, 0, 0); // local time, like groupByDay
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const MIN = 60_000;

  it("under a minute (or a clock a little ahead) reads 'now'", () => {
    expect(noticeTimeLabel(ago(20_000), now, "en")).toBe(rtf("en").format(0, "second"));
    expect(noticeTimeLabel(ago(-90_000), now, "en")).toBe(rtf("en").format(0, "second"));
    expect(rtf("en").format(0, "second")).toBe("now");
  });

  it("minutes, then hours, within the same day", () => {
    expect(noticeTimeLabel(ago(5 * MIN), now, "en")).toBe(rtf("en").format(-5, "minute"));
    expect(noticeTimeLabel(ago(59 * MIN), now, "en")).toBe(rtf("en").format(-59, "minute"));
    expect(noticeTimeLabel(ago(3 * 60 * MIN + 10 * MIN), now, "en")).toBe(rtf("en").format(-3, "hour"));
  });

  it("a notice from before midnight reads 'yesterday' even if it is minutes old — same as its group", () => {
    const justAfterMidnight = new Date(2026, 9, 4, 0, 30);
    const createdAt = new Date(2026, 9, 3, 23, 50).toISOString();
    expect(noticeTimeLabel(createdAt, justAfterMidnight, "en")).toBe("yesterday");
    expect(groupByDay([{ createdAt }], justAfterMidnight)[0].key).toBe("yesterday");
  });

  it("calendar days up to six, then the date", () => {
    expect(noticeTimeLabel(new Date(2026, 9, 2, 18, 0).toISOString(), now, "en")).toBe(rtf("en").format(-2, "day"));
    expect(noticeTimeLabel(new Date(2026, 8, 28, 9, 0).toISOString(), now, "en")).toBe(rtf("en").format(-6, "day"));
    const weekOld = new Date(2026, 8, 27, 9, 0).toISOString();
    expect(noticeTimeLabel(weekOld, now, "en")).toBe(formatDateLocale(weekOld));
  });

  it("follows the reader's locale", () => {
    expect(noticeTimeLabel(ago(5 * MIN), now, "pt")).toBe(rtf("pt").format(-5, "minute"));
    expect(noticeTimeLabel(ago(5 * MIN), now, "pt")).not.toBe(noticeTimeLabel(ago(5 * MIN), now, "en"));
  });

  it("a malformed timestamp shows a dash", () => {
    expect(noticeTimeLabel("not a date", now, "en")).toBe("—");
  });
});

describe("list updates (optimistic read / remove with rollback)", () => {
  const a = { ...expenseNew(), publicId: "a", read: false };
  const b = { ...debtReminder, publicId: "b", read: true };
  const c = { ...recurringDue, publicId: "c", read: false };
  const list: AppNotification[] = [a, b, c];

  it("setNoticeRead flips one notice and leaves the input untouched", () => {
    const next = setNoticeRead(list, "a", true);
    expect(next.map((n) => n.read)).toEqual([true, true, false]);
    expect(list[0].read).toBe(false);
    expect(setNoticeRead(next, "a", false)[0].read).toBe(false);
  });

  it("markAllNoticesRead + restoreUnread undo each other for the notices that were unread", () => {
    const ids = unreadIds(list);
    expect([...ids]).toEqual(["a", "c"]);
    const allRead = markAllNoticesRead(list);
    expect(allRead.every((n) => n.read)).toBe(true);
    expect(restoreUnread(allRead, ids).map((n) => n.read)).toEqual([false, true, false]);
  });

  it("removeNotice drops the notice; restoreNotice puts it back where it was", () => {
    const without = removeNotice(list, "b");
    expect(without.map((n) => n.publicId)).toEqual(["a", "c"]);
    expect(list).toHaveLength(3);
    expect(restoreNotice(without, b, 1).map((n) => n.publicId)).toEqual(["a", "b", "c"]);
  });

  it("restoreNotice never duplicates and clamps an index past the end", () => {
    expect(restoreNotice(list, b, 1)).toBe(list);
    expect(restoreNotice([a], c, 5).map((n) => n.publicId)).toEqual(["a", "c"]);
  });

  it("removeNotice of an id not in the list changes nothing", () => {
    expect(removeNotice(list, "zzz")).toBe(list);
  });

  it("the Unread filter hides read notices (an optimistic read drops out of it)", () => {
    expect(visibleNotices(list, "all")).toBe(list);
    expect(visibleNotices(list, "unread").map((n) => n.publicId)).toEqual(["a", "c"]);
  });

  it("after a remove, focus moves to the next row, else the previous one, else nowhere", () => {
    expect(focusAfterRemove(list, "a")).toBe("b");
    expect(focusAfterRemove(list, "b")).toBe("c");
    expect(focusAfterRemove(list, "c")).toBe("b");
    expect(focusAfterRemove([a], "a")).toBeNull();
    expect(focusAfterRemove(list, "zzz")).toBeNull();
  });
});

describe("install banner (criteria 2 and 3)", () => {
  const env = (overrides: Partial<InstallEnv>): InstallEnv => ({
    standalone: false,
    installed: false,
    canPrompt: false,
    ios: false,
    dismissed: false,
    promptUsed: false,
    ...overrides,
  });

  it("shows when the browser offers the prompt, or on iPhone/iPad (manual steps)", () => {
    expect(installBannerVisible(env({ canPrompt: true }))).toBe(true);
    expect(installBannerVisible(env({ ios: true }))).toBe(true);
  });

  it("never while running standalone, after appinstalled, or within the 30-day 'Not now'", () => {
    expect(installBannerVisible(env({ canPrompt: true, standalone: true }))).toBe(false);
    expect(installBannerVisible(env({ ios: true, standalone: true }))).toBe(false);
    expect(installBannerVisible(env({ canPrompt: true, installed: true }))).toBe(false);
    expect(installBannerVisible(env({ canPrompt: true, dismissed: true }))).toBe(false);
    expect(installBannerVisible(env({ ios: true, dismissed: true }))).toBe(false);
  });

  it("hidden where the browser cannot install (Firefox desktop, Safari macOS)", () => {
    expect(installBannerVisible(env({}))).toBe(false);
  });

  it("hidden once the one-time prompt was used (until the browser offers a new one)", () => {
    expect(installBannerVisible(env({ promptUsed: true }))).toBe(false);
    expect(installBannerVisible(env({ promptUsed: true, canPrompt: true }))).toBe(true);
  });
});

describe("'App on home screen' card state", () => {
  const env = (overrides: Partial<InstallEnv>) => ({
    standalone: false,
    installed: false,
    canPrompt: false,
    ios: false,
    promptUsed: false,
    ...overrides,
  });

  it("reads Installed while standalone or once appinstalled fired", () => {
    expect(installCardState(env({ standalone: true }))).toBe("installed");
    expect(installCardState(env({ standalone: true, ios: true }))).toBe("installed");
    expect(installCardState(env({ installed: true, canPrompt: true }))).toBe("installed");
    expect(installCardState(env({ installed: true, promptUsed: true }))).toBe("installed");
  });

  it("native prompt, manual iOS steps, or unsupported", () => {
    expect(installCardState(env({ canPrompt: true }))).toBe("prompt");
    expect(installCardState(env({ ios: true }))).toBe("manual");
    expect(installCardState(env({}))).toBe("unsupported");
  });

  it("after the one-time prompt was used (or came back unavailable): no button, but never 'can't install'", () => {
    expect(installCardState(env({ promptUsed: true }))).toBe("promptUsed");
    // A new beforeinstallprompt brings the button back; iPhone keeps its manual steps.
    expect(installCardState(env({ promptUsed: true, canPrompt: true }))).toBe("prompt");
    expect(installCardState(env({ promptUsed: true, ios: true }))).toBe("manual");
  });

  it("the dismissal only hides the banner, never the card", () => {
    expect(installCardState({ ...env({ canPrompt: true }), dismissed: true } as InstallEnv)).toBe("prompt");
  });
});

describe("truly unsupported browser (the only case that says the browser can't install apps)", () => {
  const env = (overrides: Partial<InstallEnv>) => ({ canPrompt: false, ios: false, promptUsed: false, ...overrides });

  it("no prompt now, none used before, and not iPhone/iPad (Firefox desktop, Safari macOS)", () => {
    expect(installUnsupported(env({}))).toBe(true);
    expect(installUnsupported(env({ canPrompt: true }))).toBe(false);
    expect(installUnsupported(env({ ios: true }))).toBe(false);
    expect(installUnsupported(env({ promptUsed: true }))).toBe(false);
  });
});

describe("install sheet, Android tab", () => {
  const env = (overrides: Partial<InstallEnv>) => ({ canPrompt: false, ios: false, promptUsed: false, ...overrides });

  it("the native prompt while the browser offers one", () => {
    expect(installSheetAndroid(env({ canPrompt: true }))).toBe("prompt");
    expect(installSheetAndroid(env({ canPrompt: true, promptUsed: true }))).toBe("prompt");
  });

  it("the browser-menu step once the prompt was used, and for an iPhone reading the Android tab", () => {
    expect(installSheetAndroid(env({ promptUsed: true }))).toBe("menu");
    expect(installSheetAndroid(env({ ios: true }))).toBe("menu");
  });

  it("the unsupported text only where the browser never can install", () => {
    expect(installSheetAndroid(env({}))).toBe("unsupported");
  });
});
