import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import type { Locale } from "@/i18n/locales";
import { notificationHref, type NotificationType } from "@/lib/notifications";

// The push copy of a notice (spec 010, criterion 6). Its text shows on a lock screen, so it says who did what and
// names the description, never the amount or notes; the full text stays in the in-app center. Rendered on the
// server in the subscription's locale (the `Push` namespace) and sent end-to-end encrypted by web-push.

/** What the service worker shows: `title` + `body`, opens `url` on tap; a newer push with the same `tag` replaces it. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** What a push reads of a notice row: its type and render params (only `description` and `recurring`). */
export interface PushNotice {
  type: NotificationType;
  params: unknown;
}

export interface PushPayloadInput {
  notification: PushNotice;
  /** The subscription's locale; anything outside en/pt/es/fr renders in en. */
  locale: string;
  houseName: string;
  housePublicId: string;
  /** The actor's current display name; null = unknown or automatic ("Someone" where a text names one). */
  actorName: string | null;
}

const MESSAGES: Record<Locale, typeof en.Push> = { en: en.Push, pt: pt.Push, es: es.Push, fr: fr.Push };

/** Characters (graphemes). The actor cap is not in the design: it keeps an unbounded Google name off the 4 KB limit. */
const MAX = { title: 40, description: 60, actor: 40 } as const;
/**
 * A grapheme has no length limit (a letter can carry any number of combining marks), so each text also stays within
 * 8 UTF-16 units per allowed character: far above real text (a flag is 4 units, a ZWJ family 11), yet at most
 * ~3.4 KB of UTF-8 for the three texts together — the payload stays under the 4 KB Web Push limit.
 */
const UNITS_PER_CHARACTER = 8;
/** User-perceived characters: a flag, a ZWJ family or a letter with its accents is one, never split at a limit. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const APP_NAME = "Home Share";
const TEST_URL = "/notifications";

function translator(locale: string) {
  const known: Locale = Object.hasOwn(MESSAGES, locale) ? (locale as Locale) : "en";
  return createTranslator({ locale: known, messages: { Push: MESSAGES[known] }, namespace: "Push" });
}

/**
 * At most `max` characters (graphemes); a longer text keeps max − 1 of them (trailing spaces dropped) plus "…". The
 * unit budget only bites on stacked combining marks: the cut then falls on the last whole grapheme that fits.
 */
function truncate(text: string, max: number): string {
  const budget = max * UNITS_PER_CHARACTER;
  const graphemes = Array.from(GRAPHEMES.segment(text), (s) => s.segment);
  if (graphemes.length <= max && text.length <= budget) return text;
  let kept = "";
  for (const grapheme of graphemes.slice(0, max - 1)) {
    if (kept.length + grapheme.length > budget - 1) break;
    kept += grapheme;
  }
  return `${kept.trimEnd()}…`;
}

/** The lock-screen copy of one notice for one subscription. */
export function buildPushPayload({ notification, locale, houseName, housePublicId, actorName }: PushPayloadInput): PushPayload {
  const t = translator(locale);
  const { description, recurring } = (notification.params ?? {}) as { description?: unknown; recurring?: unknown };
  const values = {
    actor: truncate(actorName ?? t("someone"), MAX.actor),
    description: truncate(typeof description === "string" ? description : "", MAX.description),
  };
  const key = notification.type === "EXPENSE_NEW" && recurring === true ? "EXPENSE_NEW_RECURRING" : notification.type;
  const house = encodeURIComponent(housePublicId);
  return {
    title: truncate(houseName, MAX.title),
    body: t(key, values),
    url: `${notificationHref(notification.type)}?house=${house}`,
    tag: `${notification.type}:${housePublicId}`,
  };
}

/** "Send test notice" (criterion 10): user-scoped, so no house — the app's name, the center as the target. */
export function buildTestPushPayload(locale: string): PushPayload {
  return { title: APP_NAME, body: translator(locale)("TEST"), url: TEST_URL, tag: "TEST" };
}
