import { describe, expect, it } from "vitest";
import { buildPushPayload, buildTestPushPayload, type PushPayloadInput } from "@/lib/push/payload";
import { NOTIFICATION_TYPES, type NotificationType } from "@/lib/notifications";

// Spec 010 criterion 6: the push is a privacy-reduced copy of a spec 009 notice. Its text shows on a lock screen,
// so it carries who + what + the description, never the amount or notes, rendered in the subscription's locale.

const HOUSE = "0192f0c4-0000-7000-8000-00000000abcd";
const LOCALES = ["en", "pt", "es", "fr"] as const;

/** A notice row's render params as spec 009 stores them, plus a stray `notes` that must never surface. */
const params = {
  expensePublicId: "0192f0c4-0000-7000-8000-000000000001",
  settlementPublicId: "0192f0c4-0000-7000-8000-000000000002",
  recurringExpensePublicId: "0192f0c4-0000-7000-8000-000000000003",
  fromUserId: 42,
  description: "Electricity",
  amount: "987654.32",
  dueOn: "2026-10-05",
  notes: "SECRET NOTE",
};

const input = (type: NotificationType, overrides: Partial<PushPayloadInput> = {}): PushPayloadInput => ({
  notification: { type, params },
  locale: "en",
  houseName: "Casa Bolitas",
  housePublicId: HOUSE,
  actorName: "Bruno",
  ...overrides,
});

/** Every body variant: each type, plus the automatic (recurring) posting of an expense. */
const VARIANTS: [label: string, PushPayloadInput][] = [
  ...NOTIFICATION_TYPES.map((type) => [type, input(type)] as [string, PushPayloadInput]),
  ["EXPENSE_NEW recurring", input("EXPENSE_NEW", { notification: { type: "EXPENSE_NEW", params: { ...params, recurring: true } }, actorName: null })],
];

describe("buildPushPayload — the lock-screen copy of a notice (spec 010, criterion 6)", () => {
  it.each(VARIANTS.flatMap(([label, base]) => LOCALES.map((locale) => [label, locale, { ...base, locale }] as const)))(
    "%s (%s): no amount, no notes, no ids — exactly { title, body, url, tag }",
    (_label, _locale, payloadInput) => {
      const payload = buildPushPayload(payloadInput);
      expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
      // No digit at all on the lock screen: neither the amount (987654.32, in any locale's format) nor a due date.
      expect(`${payload.title} ${payload.body}`).not.toMatch(/\d/);
      expect(JSON.stringify(payload)).not.toMatch(/SECRET|987|654|0192f0c4-0000-7000-8000-00000000000/);
    }
  );

  it("en: the design's texts — actor + description, automatic posting, payment, balance, due tomorrow", () => {
    const body = (payloadInput: PushPayloadInput) => buildPushPayload(payloadInput).body;
    expect(body(input("EXPENSE_NEW"))).toBe("Bruno added “Electricity”");
    expect(body(VARIANTS[4][1])).toBe("“Electricity” was posted automatically");
    expect(body(input("PAYMENT_RECEIVED"))).toBe("Bruno recorded a payment to you");
    expect(body(input("DEBT_REMINDER", { actorName: null }))).toBe("You have an open balance to settle");
    expect(body(input("RECURRING_DUE", { actorName: null }))).toBe("“Electricity” is due tomorrow");
  });

  it("renders in the subscription's locale (pt vs en), with the house name as the title", () => {
    const en = buildPushPayload(input("EXPENSE_NEW"));
    const pt = buildPushPayload(input("EXPENSE_NEW", { locale: "pt" }));
    expect(en).toMatchObject({ title: "Casa Bolitas", body: "Bruno added “Electricity”" });
    expect(pt).toMatchObject({ title: "Casa Bolitas", body: "Bruno adicionou “Electricity”" });
    expect(buildPushPayload(input("RECURRING_DUE", { locale: "pt" })).body).toBe("“Electricity” vence amanhã");
  });

  it("an unknown locale (a stale row) falls back to en", () => {
    expect(buildPushPayload(input("EXPENSE_NEW", { locale: "de" })).body).toBe("Bruno added “Electricity”");
  });

  it.each([
    ["en", "Someone recorded a payment to you"],
    ["pt", "Alguém registrou um pagamento para você"],
  ] as const)("%s: a notice whose actor is unknown names 'someone'", (locale, expected) => {
    expect(buildPushPayload(input("PAYMENT_RECEIVED", { locale, actorName: null })).body).toBe(expected);
  });

  it("the automatic posting of an expense names no actor, even when one is passed", () => {
    const payload = buildPushPayload({ ...VARIANTS[4][1], actorName: "Bruno" });
    expect(payload.body).not.toContain("Bruno");
  });

  it("the description is inserted verbatim (never parsed as a message)", () => {
    const tricky = "Rent {month} <b>'x'</b> #";
    const payload = buildPushPayload(input("EXPENSE_NEW", { notification: { type: "EXPENSE_NEW", params: { ...params, description: tricky } } }));
    expect(payload.body).toBe(`Bruno added “${tricky}”`);
  });

  describe("truncation (title 40, description 60, actor 40 characters)", () => {
    it("a long house name is cut to 40 characters, the last one an ellipsis", () => {
      const { title } = buildPushPayload(input("DEBT_REMINDER", { houseName: "H".repeat(50) }));
      expect(title).toBe(`${"H".repeat(39)}…`);
      expect([...title]).toHaveLength(40);
    });

    it("a long description is cut to 60 characters inside the quotes", () => {
      const description = "D".repeat(80);
      const { body } = buildPushPayload(input("RECURRING_DUE", { notification: { type: "RECURRING_DUE", params: { ...params, description } } }));
      expect(body).toBe(`“${"D".repeat(59)}…” is due tomorrow`);
    });

    it("a long actor name is cut to 40 characters", () => {
      const { body } = buildPushPayload(input("PAYMENT_RECEIVED", { actorName: "A".repeat(90) }));
      expect(body).toBe(`${"A".repeat(39)}… recorded a payment to you`);
    });

    it("texts at the limit are kept whole", () => {
      const description = "D".repeat(60);
      const payload = buildPushPayload(
        input("EXPENSE_NEW", { houseName: "H".repeat(40), actorName: "A".repeat(40), notification: { type: "EXPENSE_NEW", params: { ...params, description } } })
      );
      expect(payload.title).toBe("H".repeat(40));
      expect(payload.body).toBe(`${"A".repeat(40)} added “${description}”`);
    });

    it("counts characters, not UTF-16 units: an emoji is never split in half", () => {
      const { title } = buildPushPayload(input("DEBT_REMINDER", { houseName: "🏠".repeat(45) }));
      expect(title).toBe(`${"🏠".repeat(39)}…`);
      expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    });

    // Graphemes, not code points: what a person sees as one character is never split at the limit.
    it("a flag (two regional indicators) at the limit is kept whole", () => {
      const { title } = buildPushPayload(input("DEBT_REMINDER", { houseName: `${"H".repeat(38)}🇧🇷 and more` }));
      expect(title).toBe(`${"H".repeat(38)}🇧🇷…`);
    });

    it("a ZWJ family emoji at the limit is kept whole", () => {
      const family = "👨‍👩‍👧‍👦"; // 4 people joined by 3 zero-width joiners: 7 code points, 1 grapheme
      const description = `${"D".repeat(58)}${family}${"D".repeat(10)}`;
      const { body } = buildPushPayload(input("RECURRING_DUE", { notification: { type: "RECURRING_DUE", params: { ...params, description } } }));
      expect(body).toBe(`“${"D".repeat(58)}${family}…” is due tomorrow`);
    });

    it("a letter with a combining accent at the limit keeps its accent", () => {
      const accented = "é"; // e + COMBINING ACUTE ACCENT: 2 code points, 1 grapheme
      const { body } = buildPushPayload(input("PAYMENT_RECEIVED", { actorName: `${"A".repeat(38)}${accented}${"A".repeat(5)}` }));
      expect(body).toBe(`${"A".repeat(38)}${accented}… recorded a payment to you`);
    });

    it("counts each flag as one character: 40 flags are exactly at the limit and kept whole", () => {
      const houseName = "🇧🇷".repeat(40);
      expect(buildPushPayload(input("DEBT_REMINDER", { houseName })).title).toBe(houseName);
    });

    it("a pathological grapheme stack (a Google name of stacked combining marks) still cannot inflate the payload", () => {
      const zalgo = `e${"́".repeat(300)}`.repeat(40); // 40 graphemes, 12 040 UTF-16 units
      const payload = buildPushPayload(input("PAYMENT_RECEIVED", { actorName: zalgo }));
      expect(payload.body).toMatch(/^é+… recorded a payment to you$/);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024);
    });

    // The real worst case (cycle C review): 3-byte UTF-8 combining marks (U+20D0) stacked in ALL three texts, every
    // locale and type. aes128gcm leaves 4096 − 86 (header) − 16 (tag) − 1 (delimiter) = 3993 B of plaintext.
    it("the worst case — 3-byte combining marks stacked in house, actor and description — stays under 3993 B", () => {
      const stack = (graphemes: number) => `e${"⃐".repeat(300)}`.repeat(graphemes);
      for (const locale of ["en", "pt", "es", "fr"] as const) {
        for (const type of NOTIFICATION_TYPES) {
          const payload = buildPushPayload(
            input(type, {
              locale,
              houseName: stack(80),
              actorName: stack(80),
              notification: { type, params: { ...params, description: stack(120) } },
            })
          );
          expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(3993);
        }
      }
    });

    it("trailing spaces are not kept before the ellipsis", () => {
      const { title } = buildPushPayload(input("DEBT_REMINDER", { houseName: `${"H".repeat(37)}      tail` }));
      expect(title).toBe(`${"H".repeat(37)}…`);
    });

    it("the longest inputs still make a small payload (far below the 4 KB Web Push limit)", () => {
      const payload = buildPushPayload(
        input("EXPENSE_NEW", {
          locale: "fr",
          houseName: "🏠".repeat(80),
          actorName: "🙂".repeat(200),
          notification: { type: "EXPENSE_NEW", params: { ...params, description: "🧾".repeat(200) } },
        })
      );
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024);
    });
  });

  it.each([
    ["EXPENSE_NEW", "/expenses"],
    ["PAYMENT_RECEIVED", "/balances"],
    ["DEBT_REMINDER", "/balances"],
    ["RECURRING_DUE", "/recurring"],
  ] as const)("%s: url = the notice's screen + ?house=<house publicId>; tag = <type>:<house publicId>", (type, screen) => {
    const payload = buildPushPayload(input(type));
    expect(payload.url).toBe(`${screen}?house=${HOUSE}`);
    expect(payload.tag).toBe(`${type}:${HOUSE}`);
  });

  it("the automatic posting of an expense keeps the EXPENSE_NEW tag (a burst from one house replaces one banner)", () => {
    expect(buildPushPayload(VARIANTS[4][1]).tag).toBe(`EXPENSE_NEW:${HOUSE}`);
  });
});

describe("buildTestPushPayload — 'Send test notice' (spec 010, criterion 10)", () => {
  it.each([
    ["en", "Notifications are working on this device"],
    ["pt", "As notificações estão funcionando neste dispositivo"],
    ["de", "Notifications are working on this device"],
  ] as const)("%s", (locale, body) => {
    expect(buildTestPushPayload(locale)).toEqual({ title: "Home Share", body, url: "/notifications", tag: "TEST" });
  });
});
