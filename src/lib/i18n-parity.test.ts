import { describe, it, expect } from "vitest";
import { createTranslator } from "next-intl";
import { IntlMessageFormat } from "intl-messageformat";
import { TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import { REVISION_ENTITY_TYPES } from "@/lib/constants";
import { NOTIFICATION_TYPES } from "@/lib/notifications";

// Reusable i18n guard (spec 008 task 16). The generic blocks cover EVERY namespace, so a key added to
// en.json and forgotten in another locale, a broken ICU string or a dropped {placeholder} fails here
// without anyone editing this file. Only SPEC_008_KEYS and SPEC_009_KEYS are feature-specific.

type Tree = { [key: string]: string | Tree };

const LOCALES = { en, pt, es, fr } as const;
type LocaleName = keyof typeof LOCALES;
const ALL: LocaleName[] = ["en", "pt", "es", "fr"];
const OTHERS: Exclude<LocaleName, "en">[] = ["pt", "es", "fr"];

function flatten(tree: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

const FLAT = Object.fromEntries(ALL.map((l) => [l, flatten(LOCALES[l] as Tree)])) as Record<LocaleName, Record<string, string>>;

/** Argument names ("count", "name", "<num>") a message reads, whatever the locale's wording. */
function argumentNames(ast: MessageFormatElement[], out = new Set<string>()): Set<string> {
  for (const node of ast) {
    if (node.type === TYPE.tag) {
      out.add(`<${node.value}>`);
      argumentNames(node.children, out);
    } else if (node.type !== TYPE.literal && node.type !== TYPE.pound) {
      out.add(node.value);
      if (node.type === TYPE.select || node.type === TYPE.plural) {
        for (const option of Object.values(node.options)) argumentNames(option.value, out);
      }
    }
  }
  return out;
}

const argsOf = (message: string, locale: LocaleName) =>
  [...argumentNames(new IntlMessageFormat(message, locale).getAst())].sort().join(", ");

describe("i18n parity — every namespace", () => {
  it.each(OTHERS)("%s has exactly the keys of en", (locale) => {
    const keys = Object.keys(FLAT[locale]);
    expect({
      missing: Object.keys(FLAT.en).filter((k) => !(k in FLAT[locale])),
      extra: keys.filter((k) => !(k in FLAT.en)),
    }).toEqual({ missing: [], extra: [] });
  });

  it.each(ALL)("%s: no message is empty", (locale) => {
    expect(Object.entries(FLAT[locale]).filter(([, v]) => v.trim() === "").map(([k]) => k)).toEqual([]);
  });

  it.each(ALL)("%s: every message is valid ICU", (locale) => {
    const broken: string[] = [];
    for (const [key, message] of Object.entries(FLAT[locale])) {
      try {
        new IntlMessageFormat(message, locale);
      } catch {
        broken.push(key);
      }
    }
    expect(broken).toEqual([]);
  });

  it.each(OTHERS)("%s: every message reads the same {placeholders} and <tags> as en", (locale) => {
    const different: string[] = [];
    for (const [key, message] of Object.entries(FLAT.en)) {
      const translated = FLAT[locale][key];
      if (translated !== undefined && argsOf(message, "en") !== argsOf(translated, locale)) different.push(key);
    }
    expect(different).toEqual([]);
  });
});

// The keys spec 008 adds (design.md › i18n keys), by namespace.
const SPEC_008_KEYS: Record<string, string[]> = {
  Nav: ["recurring"],
  Recurring: [
    "title", "subtitle", "monthlyTotal", "counts", "yourShare", "newRule",
    "tabs.rules", "tabs.upcoming", "tabs.posted",
    "monthlyTag", "everyDay", "perPerson", "paused", "pausedNothing", "pausedMemberLeft", "monthSkipped", "backIn",
    "nextPosting", "skipMonth", "undoSkip", "pause", "resume", "edit", "delete", "actionsFor", "deleteTitle", "deleteBody",
    "form.createTitle", "form.editTitle", "form.description", "form.descriptionHint", "form.amount", "form.day",
    "form.dayDecrease", "form.dayIncrease", "form.dayHintClamp", "form.dayHintWeekend", "form.payer", "form.split",
    "form.splitAll", "form.splitPick", "form.preview", "form.firstPosting", "form.previewEmpty", "form.create",
    "form.save", "form.cancel",
    "upcoming.auto", "upcoming.skipped", "upcoming.empty",
    "posted.recurringTag", "posted.skippedNothing", "posted.expenseDeleted", "posted.empty",
    "empty", "emptyHint",
    "toast.created", "toast.createdPostedToday", "toast.saved", "toast.paused", "toast.resumed", "toast.skipped",
    "toast.unskipped", "toast.deleted",
    "you",
    // Tasks 18–19 (UI): a posting made right away by a resume or an edit, and the screen's error fallbacks.
    "toast.resumedPostedToday", "toast.savedPostedNow", "loadError", "saveError", "actionError",
    // Cycle F fix 1: the viewer as payer ("paid by you"), and the edit preview's next posting.
    "everyDayYou", "form.nextPosting",
  ],
  Expenses: ["recurringBadge", "recurringDetail"],
  Activity: [
    "automatic",
    "act.CREATE_RECURRING_EXPENSE", "act.UPDATE_RECURRING_EXPENSE", "act.DELETE_RECURRING_EXPENSE",
    "act.PAUSE_RECURRING_EXPENSE", "act.RESUME_RECURRING_EXPENSE", "act.SKIP_RECURRING_EXPENSE",
    "act.UNSKIP_RECURRING_EXPENSE", "act.SKIP_RECURRING_EXPENSE_MONTH", "act.UNSKIP_RECURRING_EXPENSE_MONTH",
    "entity.RecurringExpense", "entityArticle.RecurringExpense",
    "field.dayOfMonth", "field.splitMode", "field.participantIds", "field.pausedAt", "field.pauseReason",
    "field.skippedPeriods",
    "splitModeValue.ALL", "splitModeValue.SELECTED",
    "pauseReasonValue.MANUAL", "pauseReasonValue.MEMBER_LEFT",
  ],
  ApiErrors: [
    "RECURRING_NOT_FOUND", "RECURRING_DAY_INVALID", "RECURRING_SPLIT_INVALID", "RECURRING_TIMEZONE_INVALID",
    "RECURRING_MEMBER_INACTIVE", "RECURRING_LIMIT_REACHED", "RECURRING_PERIOD_INVALID", "RECURRING_PERIOD_CLOSED",
    "RECURRING_PATCH_INVALID", "STALE_RECURRING_EXPENSE", "NOT_RECURRING_OWNER",
    // Returned by assertExpectedGroup on every mutation body that carries expectedGroupId.
    "STALE_GROUP",
    // Returned by validateExpenseInput since before this spec, but no locale translated them.
    "AMOUNT_PRECISION", "DESCRIPTION_INVALID",
  ],
};
const SPEC_008_PATHS = Object.entries(SPEC_008_KEYS).flatMap(([ns, keys]) => keys.map((k) => `${ns}.${k}`));

describe("i18n — spec 008 (recurring expenses) keys", () => {
  it("lists every key of the design", () => expect(SPEC_008_PATHS).toHaveLength(new Set(SPEC_008_PATHS).size));

  it.each(ALL)("%s has every key, each with text", (locale) => {
    expect(SPEC_008_PATHS.filter((path) => !FLAT[locale][path]?.trim())).toEqual([]);
  });

  it.each(OTHERS)("%s: the new strings are written in that language, not copied from en", (locale) => {
    // Shared words are legitimate ("Admin"); a whole sentence left in English is not. Short labels that are
    // spelled the same (pt/es "Pausar" vs en "Pause" differ, fr "Menu"…) are exempt via the length floor.
    const copied = SPEC_008_PATHS.filter((p) => FLAT[locale][p] === FLAT.en[p] && FLAT.en[p].length > 24);
    expect(copied).toEqual([]);
  });

  it("pt keeps the neutral register: 'para', never 'pra'", () => {
    const informal = SPEC_008_PATHS.filter((p) => /\bpra\b/i.test(FLAT.pt[p]));
    expect(informal).toEqual([]);
  });

  it("fr puts a non-breaking space before : ; ? ! (a line never opens with the mark)", () => {
    const loose = SPEC_008_PATHS.filter((p) => /(^|[^\u00a0])[:;?!]/.test(FLAT.fr[p]));
    expect(loose).toEqual([]);
  });
});

describe("Recurring.counts (plural + optional paused suffix)", () => {
  const counts = (locale: LocaleName, values: { active: number; paused: number }) =>
    createTranslator({ locale, messages: LOCALES[locale], namespace: "Recurring" })("counts", values);

  it("en: singular and plural, the paused part only when there is one", () => {
    expect(counts("en", { active: 1, paused: 0 })).toBe("1 active rule");
    expect(counts("en", { active: 3, paused: 0 })).toBe("3 active rules");
    expect(counts("en", { active: 3, paused: 1 })).toBe("3 active rules · 1 paused");
    expect(counts("en", { active: 0, paused: 2 })).toBe("no active rules · 2 paused");
  });

  // pt and fr put 0 in the "one" category ("0 regra ativa"): every locale words zero on its own.
  it.each([
    ["en", "no active rules · 2 paused"],
    ["pt", "nenhuma regra ativa · 2 pausadas"],
    ["es", "ninguna regla activa · 2 pausadas"],
    ["fr", "aucune règle active · 2 en pause"],
  ] as const)("%s: no active rule reads as a word, not a number in the singular", (locale, expected) => {
    expect(counts(locale, { active: 0, paused: 2 })).toBe(expected);
  });

  it.each(OTHERS)("%s: shows both numbers, and no paused part when none is paused", (locale) => {
    const both = counts(locale, { active: 3, paused: 2 });
    expect(both).toContain("3");
    expect(both).toContain("2");
    expect(counts(locale, { active: 3, paused: 0 })).not.toMatch(/·/);
  });
});

// Activity › Detailed: each filter chip is an entity label, and a row without a dedicated phrase reads
// "<action> <article>" — so every entity the route allows needs both texts in every locale.
describe("Activity Detailed entity types", () => {
  it("includes the recurring rule", () => expect(REVISION_ENTITY_TYPES).toContain("RecurringExpense"));

  it.each(ALL)("%s: every filterable entity has a label and an article", (locale) => {
    const missing = REVISION_ENTITY_TYPES.flatMap((type) =>
      [`Activity.entity.${type}`, `Activity.entityArticle.${type}`].filter((path) => !FLAT[locale][path]?.trim())
    );
    expect(missing).toEqual([]);
  });
});

describe("Activity skip phrases that name the month (spec 008)", () => {
  it.each(ALL)("%s: the month is placed in both sentences, with no other placeholder", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Activity.act" });
    for (const key of ["SKIP_RECURRING_EXPENSE_MONTH", "UNSKIP_RECURRING_EXPENSE_MONTH"] as const) {
      expect(t(key, { month: "MONTH-X" })).toContain("MONTH-X");
      expect(argsOf(FLAT[locale][`Activity.act.${key}`], locale)).toBe("month");
    }
  });
});

// Cycle F fix 1, item 11: the share is bold inside the translated sentence (rich text, no slot hack).
describe("Recurring.yourShare (bold amount)", () => {
  it.each(ALL)("%s: the amount sits inside <b>", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Recurring" });
    expect(t.markup("yourShare", { amount: "AMOUNT-X", b: (chunks) => `[${chunks}]` })).toContain("[AMOUNT-X]");
  });
});

// Cycle F fix 1, item 12: the viewer as payer has its own sentence ("paid by You" / "paga Tú" / "payé par Vous").
describe("Recurring.everyDayYou", () => {
  it.each(ALL)("%s: names the day and never capitalizes the viewer mid-sentence", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Recurring" });
    const text = t("everyDayYou", { day: 4 });
    expect(text).toContain("4");
    expect(text).not.toContain(FLAT[locale]["Recurring.you"]);
  });
});

// E2: French writes the first of the month "le 1er"; the other days stay plain numbers.
describe("fr: day 1 is « 1er »", () => {
  const tfr = createTranslator({ locale: "fr", messages: LOCALES.fr, namespace: "Recurring" });
  const cases = [
    ["everyDay", { name: "Ana" }],
    ["everyDayYou", {}],
    ["form.firstPosting", { date: "01/11/2026" }],
    ["form.nextPosting", { date: "01/11/2026" }],
    ["toast.created", { name: "Loyer", date: "01/11/2026" }],
  ] as const;

  it.each(cases)("%s", (key, values) => {
    expect(tfr(key, { ...values, day: 1 })).toContain("le 1er de chaque mois");
    expect(tfr(key, { ...values, day: 15 })).toContain("le 15 de chaque mois");
  });

  it.each(OTHERS.filter((l) => l !== "fr"))("%s keeps the plain number on day 1", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Recurring" });
    expect(t("everyDay", { day: 1, name: "Ana" })).toContain(" 1 ");
  });
});

// Final review, item 8: "every day 5" / "cada día 5" read as "daily" — the day of month reads as a monthly
// date. (pt keeps "todo dia 5", the idiomatic "every 5th"; fr already says "le 5 de chaque mois".)
describe("Recurring day of month reads as monthly, not daily", () => {
  const cases = [
    ["everyDay", { name: "Ana" }],
    ["everyDayYou", {}],
    ["form.firstPosting", { date: "01/11/2026" }],
    ["form.nextPosting", { date: "01/11/2026" }],
    ["toast.created", { name: "Rent", date: "01/11/2026" }],
  ] as const;
  const monthly = { en: "on day 5 of every month", es: "el día 5 de cada mes" } as const;

  it.each(["en", "es"] as const)("%s", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Recurring" });
    for (const [key, values] of cases) {
      const text = t(key, { ...values, day: 5 });
      expect(text).toContain(monthly[locale]);
      expect(text).not.toMatch(/every day|cada día/);
    }
  });
});

// The keys spec 009 adds (design.md › i18n keys), by namespace.
const SPEC_009_KEYS: Record<string, string[]> = {
  Notifications: [
    "title", "subtitle", "bell", "bellCount",
    "tabs.notices", "tabs.preferences",
    "filter.all", "filter.unread",
    "markAllRead",
    "group.today", "group.yesterday", "group.earlier",
    "unreadDot", "remove", "allCaughtUp", "emptyAll", "emptyUnread", "limitNotice", "loadError", "automatic",
    "actionError", "prefError", "prefsLoadError",
    "text.EXPENSE_NEW", "text.EXPENSE_NEW_RECURRING", "text.PAYMENT_RECEIVED", "text.DEBT_REMINDER",
    "text.RECURRING_DUE",
    "types.EXPENSE_NEW.label", "types.EXPENSE_NEW.description",
    "types.PAYMENT_RECEIVED.label", "types.PAYMENT_RECEIVED.description",
    "types.DEBT_REMINDER.label", "types.DEBT_REMINDER.description",
    "types.RECURRING_DUE.label", "types.RECURRING_DUE.description",
    "prefsTypes",
    "toast.removed", "toast.allRead", "toast.prefOn", "toast.prefOff",
    "install.bannerTitle", "install.bannerBody", "install.install", "install.notNow", "install.notNowToast",
    "install.sheetTitle", "install.android", "install.iphone", "install.iosIntro",
    "install.iosStep1", "install.iosStep2", "install.iosStep3", "install.iosDone",
    "install.installedStamp", "install.installedBody",
    "install.cardTitle", "install.cardBody", "install.cardInstalled", "install.unsupported",
    "install.androidMenu",
  ],
  ApiErrors: ["NOTIFICATION_NOT_FOUND", "NOTIFICATION_PATCH_INVALID", "NOTIFICATION_PREF_INVALID"],
};
const SPEC_009_PATHS = Object.entries(SPEC_009_KEYS).flatMap(([ns, keys]) => keys.map((k) => `${ns}.${k}`));

describe("i18n — spec 009 (notification center) keys", () => {
  it("lists every key of the design", () => expect(SPEC_009_PATHS).toHaveLength(new Set(SPEC_009_PATHS).size));

  it.each(ALL)("%s has every key, each with text", (locale) => {
    expect(SPEC_009_PATHS.filter((path) => !FLAT[locale][path]?.trim())).toEqual([]);
  });

  it.each(OTHERS)("%s: the new strings are written in that language, not copied from en", (locale) => {
    // Same floor as spec 008: shared short labels ("Android", "iPhone", "Home Share") are legitimate.
    const copied = SPEC_009_PATHS.filter((p) => FLAT[locale][p] === FLAT.en[p] && FLAT.en[p].length > 24);
    expect(copied).toEqual([]);
  });

  it("pt keeps the neutral register: 'para', never 'pra'", () => {
    const informal = SPEC_009_PATHS.filter((p) => /\bpra\b/i.test(FLAT.pt[p]));
    expect(informal).toEqual([]);
  });

  it("fr puts a non-breaking space before : ; ? ! (a line never opens with the mark)", () => {
    const loose = SPEC_009_PATHS.filter((p) => /(^|[^\u00a0])[:;?!]/.test(FLAT.fr[p]));
    expect(loose).toEqual([]);
  });

  // Review of cycle E: fr "avis" reads as "reviews", so the notice list is "les notifications" (feminine).
  it("fr names the notice list 'notification(s)', never 'avis'", () => {
    expect(SPEC_009_PATHS.filter((p) => /\bavis\b/i.test(FLAT.fr[p]))).toEqual([]);
    for (const key of ["title", "bell", "tabs.notices"]) expect(FLAT.fr[`Notifications.${key}`]).toBe("Notifications");
  });

  it("fr quotes the iOS menu item in guillemets with non-breaking spaces (like ApiErrors.CANNOT_REMOVE_SELF)", () => {
    expect(FLAT.fr["Notifications.install.iosStep2"]).toBe("Choisissez \u00ab\u00a0Sur l'\u00e9cran d'accueil\u00a0\u00bb.");
    expect(FLAT.fr["Notifications.install.androidMenu"]).toContain("\u00ab\u00a0Installer l'application\u00a0\u00bb");
  });

  // Fix round F1: the sheet's Android tab after the one-time prompt was used names the browser menu, not "use Chrome".
  it.each(ALL)("%s: the Android manual step names the browser menu (\u22ee) and never says the browser can't install", (locale) => {
    const step = FLAT[locale]["Notifications.install.androidMenu"];
    expect(step).toContain("\u22ee");
    expect(step).toContain("Chrome");
    expect(step).not.toBe(FLAT[locale]["Notifications.install.unsupported"]);
    expect(step).not.toMatch(/iPhone|Safari/);
  });

  // Final review, minor 4 (owner-recommended option): Chrome itself shows this text whenever it is not offering the
  // prompt, so it names no browser and never claims the browser can't install.
  it("en: the neutral 'install isn't offered here' wording", () => {
    expect(FLAT.en["Notifications.install.unsupported"]).toBe(
      "Install isn't offered here — use your browser's menu, or Share › Add to Home Screen on iPhone."
    );
  });

  it.each(ALL)("%s: 'install isn't offered here' names no browser and points at the browser menu and the iPhone Share path", (locale) => {
    // The iPhone path uses the same Safari menu names as this locale's iOS steps.
    const IOS_MENU: Record<LocaleName, [share: string, addToHome: string]> = {
      en: ["Share", "Add to Home Screen"],
      pt: ["Compartilhar", "Adicionar à Tela de Início"],
      es: ["Compartir", "Añadir a pantalla de inicio"],
      fr: ["Partager", "Sur l'écran d'accueil"],
    };
    const text = FLAT[locale]["Notifications.install.unsupported"];
    const [share, addToHome] = IOS_MENU[locale];
    expect(text).not.toMatch(/Chrome|Edge|Safari/);
    expect(text).toContain("iPhone");
    expect(text).toContain(`${share} › ${addToHome}`);
    expect(FLAT[locale]["Notifications.install.iosStep1"]).toContain(share);
    expect(FLAT[locale]["Notifications.install.iosStep2"]).toContain(addToHome);
  });

  it("pt says 'despesa recorrente' (the app's word), not 'conta recorrente'", () => {
    expect(FLAT.pt["Notifications.types.RECURRING_DUE.description"]).toContain("despesa recorrente");
    expect(SPEC_009_PATHS.filter((p) => /conta recorrente/i.test(FLAT.pt[p]))).toEqual([]);
  });

  it.each(ALL)("%s: no exclamation marks (the house tone is plain)", (locale) => {
    expect(SPEC_009_PATHS.filter((p) => /!/.test(FLAT[locale][p]))).toEqual([]);
  });
});

// The UI builds `text.${type}`, `types.${type}.label` and `types.${type}.description` from the notice's
// type: a new enum value fails here until every locale has its copy.
describe("Notifications: one text, label and description per NotificationType", () => {
  it.each(ALL)("%s", (locale) => {
    const missing = NOTIFICATION_TYPES.flatMap((type) =>
      [`Notifications.text.${type}`, `Notifications.types.${type}.label`, `Notifications.types.${type}.description`].filter(
        (path) => !FLAT[locale][path]?.trim()
      )
    );
    expect(missing).toEqual([]);
  });
});

// The placeholders the page passes (design › UI): the payer of a PAYMENT_RECEIVED notice is
// `params.fromUserId` resolved like the actor, and a recurring posting names no actor at all.
describe("Notifications text placeholders", () => {
  const ARGS: Record<string, string> = {
    "text.EXPENSE_NEW": "actor, amount, description",
    "text.EXPENSE_NEW_RECURRING": "amount, description",
    "text.PAYMENT_RECEIVED": "amount, payer",
    "text.DEBT_REMINDER": "amount",
    "text.RECURRING_DUE": "amount, description",
    "toast.prefOn": "label",
    "toast.prefOff": "label",
    bellCount: "count",
  };

  it.each(ALL)("%s: each message reads exactly the arguments the page passes", (locale) => {
    const actual = Object.fromEntries(
      Object.keys(ARGS).map((key) => [key, argsOf(FLAT[locale][`Notifications.${key}`], locale)])
    );
    expect(actual).toEqual(ARGS);
  });

  it.each(ALL)("%s: the description sits inside typographic quotes “ ” in every notice that names one", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications.text" });
    const values = { actor: "ACTOR-X", payer: "PAYER-X", description: "DESC-X", amount: "AMOUNT-X" };
    for (const key of ["EXPENSE_NEW", "EXPENSE_NEW_RECURRING", "RECURRING_DUE"] as const) {
      expect(t(key, values)).toContain("“DESC-X”");
    }
  });

  it.each(ALL)("%s: every notice shows its amount, and only the ones with a person show a name", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications.text" });
    const values = { actor: "ACTOR-X", payer: "PAYER-X", description: "DESC-X", amount: "AMOUNT-X" };
    for (const key of NOTIFICATION_TYPES) expect(t(key, values)).toContain("AMOUNT-X");
    expect(t("EXPENSE_NEW", values)).toContain("ACTOR-X");
    expect(t("PAYMENT_RECEIVED", values)).toContain("PAYER-X");
    expect(t("PAYMENT_RECEIVED", values)).not.toContain("ACTOR-X");
    expect(t("EXPENSE_NEW_RECURRING", values)).not.toContain("ACTOR-X");
  });

  it.each(ALL)("%s: the switch toasts say which type changed", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications.toast" });
    expect(t("prefOn", { label: "LABEL-X" })).toContain("LABEL-X");
    expect(t("prefOff", { label: "LABEL-X" })).toContain("LABEL-X");
    expect(t("prefOn", { label: "LABEL-X" })).not.toBe(t("prefOff", { label: "LABEL-X" }));
  });
});

// pt and fr put 0 in the "one" category ("0 aviso não lido", "0 notification non lue"): the bell's label words zero itself.
describe("Notifications.bellCount (plural)", () => {
  const bell = (locale: LocaleName, count: number) =>
    createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications" })("bellCount", { count });

  it.each([
    ["en", "No unread notices", "1 unread notice", "5 unread notices"],
    ["pt", "Nenhum aviso não lido", "1 aviso não lido", "5 avisos não lidos"],
    ["es", "Ningún aviso sin leer", "1 aviso sin leer", "5 avisos sin leer"],
    ["fr", "Aucune notification non lue", "1 notification non lue", "5 notifications non lues"],
  ] as const)("%s: zero is a word, one and many carry the number", (locale, zero, one, many) => {
    expect(bell(locale, 0)).toBe(zero);
    expect(bell(locale, 1)).toBe(one);
    expect(bell(locale, 5)).toBe(many);
  });
});

// The keys spec 010 adds (design.md › i18n keys), by namespace. `Push` is rendered on the server per subscription
// locale (src/lib/push/payload.ts) and shows on a lock screen.
const SPEC_010_KEYS: Record<string, string[]> = {
  Push: ["EXPENSE_NEW", "EXPENSE_NEW_RECURRING", "PAYMENT_RECEIVED", "DEBT_REMINDER", "RECURRING_DUE", "TEST", "someone"],
  // Task 16: the "Receive on this device" card and the install banner's push wording.
  Notifications: [
    "push.title", "push.statusOn", "push.statusOff", "push.statusAsk", "push.statusDenied", "push.statusUnsupported",
    "push.statusIosInstall", "push.iosHowTo", "push.test", "push.testHint", "push.toastOn", "push.toastOff",
    "push.toastDenied", "push.toastTestSent",
    // Cycle C review minor 4: the test button waits 10 s after each send; and its own failure fallback.
    "push.testWait", "push.testError",
    // Cycle G review M2: the switch was just turned on and the browser is still asking (not on yet).
    "push.statusAsking",
    "install.bannerBodyPush",
  ],
  // The push routes' codes (RATE_LIMITED already existed); SESSION_REVOKED is the 401 of a session revoked meanwhile.
  ApiErrors: ["PUSH_NOT_CONFIGURED", "PUSH_SUBSCRIPTION_INVALID", "NO_PUSH_SUBSCRIPTION", "UNSUPPORTED_MEDIA_TYPE", "SESSION_REVOKED"],
};
const SPEC_010_PATHS = Object.entries(SPEC_010_KEYS).flatMap(([ns, keys]) => keys.map((k) => `${ns}.${k}`));

describe("i18n — spec 010 (web push) keys", () => {
  it("lists every key of the design", () => expect(SPEC_010_PATHS).toHaveLength(new Set(SPEC_010_PATHS).size));

  it.each(ALL)("%s has every key, each with text", (locale) => {
    expect(SPEC_010_PATHS.filter((path) => !FLAT[locale][path]?.trim())).toEqual([]);
  });

  it.each(OTHERS)("%s: the new strings are written in that language, not copied from en", (locale) => {
    const copied = SPEC_010_PATHS.filter((p) => FLAT[locale][p] === FLAT.en[p] && FLAT.en[p].length > 24);
    expect(copied).toEqual([]);
  });

  it("pt keeps the neutral register: 'para', never 'pra'", () => {
    expect(SPEC_010_PATHS.filter((p) => /\bpra\b/i.test(FLAT.pt[p]))).toEqual([]);
  });

  it("fr puts a non-breaking space before : ; ? ! (a line never opens with the mark)", () => {
    expect(SPEC_010_PATHS.filter((p) => /(^|[^ ])[:;?!]/.test(FLAT.fr[p]))).toEqual([]);
  });

  it.each(ALL)("%s: no exclamation marks (the house tone is plain)", (locale) => {
    expect(SPEC_010_PATHS.filter((p) => /!/.test(FLAT[locale][p]))).toEqual([]);
  });
});

// The push card (task 16): only the test toast and the wait hint take values; every other text is plain.
describe("Notifications.push placeholders and plurals", () => {
  const PUSH_KEYS = SPEC_010_KEYS.Notifications.filter((key) => key.startsWith("push."));
  const ARGS: Record<string, string> = { "push.toastTestSent": "failed, sent", "push.testWait": "seconds" };

  it.each(ALL)("%s: each message reads exactly the arguments the card passes", (locale) => {
    const actual = Object.fromEntries(PUSH_KEYS.map((key) => [key, argsOf(FLAT[locale][`Notifications.${key}`], locale)]));
    expect(actual).toEqual(Object.fromEntries(PUSH_KEYS.map((key) => [key, ARGS[key] ?? ""])));
  });

  const sent = (locale: LocaleName, values: { sent: number; failed: number }) =>
    createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications.push" })("toastTestSent", values);

  it("en: the design's wording, singular and plural, the failed part only when one failed", () => {
    expect(sent("en", { sent: 1, failed: 0 })).toBe("Sent to 1 device.");
    expect(sent("en", { sent: 3, failed: 0 })).toBe("Sent to 3 devices.");
    expect(sent("en", { sent: 2, failed: 1 })).toBe("Sent to 2 devices, 1 failed.");
    expect(sent("en", { sent: 0, failed: 2 })).toBe("Sent to 0 devices, 2 failed.");
  });

  it.each([
    ["pt", "Enviado para 1 dispositivo.", "Enviado para 3 dispositivos, 1 falhou.", "Enviado para 0 dispositivos, 2 falharam."],
    ["es", "Enviado a 1 dispositivo.", "Enviado a 3 dispositivos, 1 falló.", "Enviado a 0 dispositivos, 2 fallaron."],
    ["fr", "Envoyé à 1 appareil.", "Envoyé à 3 appareils, 1 échec.", "Envoyé à 0 appareil, 2 échecs."],
  ] as const)("%s: one / many / none delivered, with the failures agreed in number", (locale, one, someFailed, noneSent) => {
    expect(sent(locale, { sent: 1, failed: 0 })).toBe(one);
    expect(sent(locale, { sent: 3, failed: 1 })).toBe(someFailed);
    expect(sent(locale, { sent: 0, failed: 2 })).toBe(noneSent);
  });

  it.each(ALL)("%s: the wait hint carries the seconds left, singular and plural", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Notifications.push" });
    expect(t("testWait", { seconds: 1 })).toContain("1");
    expect(t("testWait", { seconds: 7 })).toContain("7");
    expect(t("testWait", { seconds: 1 })).not.toBe(t("testWait", { seconds: 7 }).replace("7", "1"));
  });

  it.each(ALL)("%s: the banner's push wording extends the plain one", (locale) => {
    const plain = FLAT[locale]["Notifications.install.bannerBody"].replace(/\.$/, "");
    expect(FLAT[locale]["Notifications.install.bannerBodyPush"].startsWith(plain)).toBe(true);
    expect(FLAT[locale]["Notifications.install.bannerBodyPush"]).not.toBe(FLAT[locale]["Notifications.install.bannerBody"]);
  });
});

// Lock-screen privacy (criterion 6): a push text can only read who and what — never {amount} — and each
// NotificationType has its own text, so a new enum value fails here until every locale has its push copy.
describe("Push texts (amount-free, one per NotificationType)", () => {
  const ARGS: Record<string, string> = {
    EXPENSE_NEW: "actor, description",
    EXPENSE_NEW_RECURRING: "description",
    PAYMENT_RECEIVED: "actor",
    DEBT_REMINDER: "",
    RECURRING_DUE: "description",
    TEST: "",
    someone: "",
  };

  it.each(ALL)("%s: each message reads exactly the arguments payload.ts passes (no amount)", (locale) => {
    const actual = Object.fromEntries(Object.keys(ARGS).map((key) => [key, argsOf(FLAT[locale][`Push.${key}`], locale)]));
    expect(actual).toEqual(ARGS);
  });

  it.each(ALL)("%s: every NotificationType has a push text", (locale) => {
    expect(NOTIFICATION_TYPES.filter((type) => !FLAT[locale][`Push.${type}`]?.trim())).toEqual([]);
  });

  it.each(ALL)("%s: the description sits inside typographic quotes “ ”, the actor is named only where the design says", (locale) => {
    const t = createTranslator({ locale, messages: LOCALES[locale], namespace: "Push" });
    const values = { actor: "ACTOR-X", description: "DESC-X" };
    for (const key of ["EXPENSE_NEW", "EXPENSE_NEW_RECURRING", "RECURRING_DUE"] as const) expect(t(key, values)).toContain("“DESC-X”");
    expect(t("EXPENSE_NEW", values)).toContain("ACTOR-X");
    expect(t("PAYMENT_RECEIVED", values)).toContain("ACTOR-X");
    expect(t("EXPENSE_NEW_RECURRING", values)).not.toContain("ACTOR-X");
  });
});
