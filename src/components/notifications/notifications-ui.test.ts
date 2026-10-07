import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/messages/en.json";

// The bell, the provider and the Notices page are client-only and fetch in effects (no DOM environment
// here), so their contracts are pinned on the source, like recurring-ui.test.ts (spec 009, tasks 18–19).
// The logic itself (texts, names, time labels, list updates, install rules) is behavior-tested in
// src/lib/notification-view.test.ts.
const FILES = {
  context: "src/lib/notifications-context.tsx",
  installHook: "src/lib/use-install-prompt.ts",
  bell: "src/components/app/NotificationBell.tsx",
  chrome: "src/components/app/AppChrome.tsx",
  layout: "src/app/(app)/layout.tsx",
  page: "src/app/(app)/notifications/page.tsx",
  item: "src/components/notifications/NotificationItem.tsx",
  prefs: "src/components/notifications/NotificationPreferences.tsx",
  banner: "src/components/notifications/InstallBanner.tsx",
  sheet: "src/components/notifications/InstallSheet.tsx",
  pushCard: "src/components/notifications/PushCard.tsx",
} as const;
const read = (path: string) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : "");
const src = Object.fromEntries(Object.entries(FILES).map(([name, path]) => [name, read(path)])) as Record<keyof typeof FILES, string>;

type Tree = { [key: string]: string | Tree };
function has(tree: Tree, path: string): boolean {
  let node: string | Tree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return typeof node === "string";
}

/** Every literal `t("key")` / `t.rich("key")` of a file, resolved against the namespace its translator reads. */
function missingKeys(source: string): string[] {
  const namespaces = new Map(
    [...source.matchAll(/const (\w+) = useTranslations\("([\w.]+)"\)/g)].map((m) => [m[1], m[2]] as const)
  );
  const missing: string[] = [];
  for (const [name, namespace] of namespaces) {
    for (const m of source.matchAll(new RegExp(`\\b${name}(?:\\.rich)?\\(\\s*"([^"]+)"`, "g"))) {
      const path = `${namespace}.${m[1]}`;
      if (!has(en as unknown as Tree, path)) missing.push(path);
    }
  }
  return missing;
}

describe("every UI text comes from the messages (en has each key the files read)", () => {
  it.each(Object.entries(FILES))("%s", (_, path) => {
    const source = read(path);
    expect(source).not.toBe("");
    expect(missingKeys(source)).toEqual([]);
  });
});

describe("unread-count provider (task 18, criterion 14)", () => {
  const ctx = src.context;

  it("reads the active house's count from the unread-count route", () => {
    expect(ctx).toContain('api.get<UnreadCountResponse>("/api/notifications/unread-count")');
  });

  it("refreshes on mount and whenever the active house changes", () => {
    expect(ctx).toMatch(/useEffect\(\(\) => \{\s*void refreshUnread\(\);\s*\}, \[groupId, refreshUnread\]\);/);
  });

  it("refreshes when the window regains focus or the tab becomes visible again", () => {
    expect(ctx).toContain('window.addEventListener("focus", onReturn)');
    expect(ctx).toContain('document.addEventListener("visibilitychange", onReturn)');
    expect(ctx).toContain('window.removeEventListener("focus", onReturn)');
    expect(ctx).toContain('document.removeEventListener("visibilitychange", onReturn)');
    expect(ctx).toContain('document.visibilityState === "visible"');
  });

  it("never polls on a timer (design › Alternatives: interval polling rejected)", () => {
    expect(ctx).not.toContain("setInterval");
    expect(ctx).not.toContain("setTimeout");
  });

  it("takes the count a mutation returned, and drops answers about a house that is no longer active", () => {
    expect(ctx).toContain("setUnreadCount: (count: number, forGroupId: number | null) => void");
    expect(ctx).toContain("if (forGroupId !== groupRef.current) return;");
    expect(ctx).toContain("seq.current === id && groupRef.current === forGroup");
  });

  it("shows another house's count never (0 until this house answers)", () => {
    expect(ctx).toContain("state.groupId === groupId ? state.count : 0");
  });

  // Final review, minor 2: a house switch in another tab moves the cookie; the next count answers for that house.
  it("drops a count the server read for another house and re-reads the session, so the bell follows the cookie", () => {
    expect(ctx).toContain("const { activeGroup, refresh: refreshSession } = useSession();");
    const refresh = ctx.slice(ctx.indexOf("const refreshUnread"), ctx.indexOf("const setUnreadCount"));
    const check = refresh.indexOf("answeredForOtherHouse(res.groupId, forGroup)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(refresh.indexOf("setState({ groupId: forGroup, count: res.count })"));
    expect(refresh).toContain("if (answeredForOtherHouse(res.groupId, forGroup)) void refreshSession().catch(");
    expect(refresh).toContain("else setState({ groupId: forGroup, count: res.count });");
  });

  it("counts each (coalesced) return to the tab, so an open Notices list reloads with the bell (C1)", () => {
    expect(ctx).toContain("returnCount: number;");
    const onReturn = ctx.slice(ctx.indexOf("const onReturn"), ctx.indexOf('window.addEventListener("focus", onReturn)'));
    expect(onReturn).toContain("RETURN_COALESCE_MS");
    expect(onReturn).toContain("setReturnCount((n) => n + 1);");
    expect(onReturn).toContain("void refreshUnread();");
    expect(ctx).toMatch(/useMemo<NotificationsValue>\([\s\S]*returnCount[\s\S]*\[unreadCount, returnCount, refreshUnread, setUnreadCount, noticeReceived\]/);
  });

  // Spec 010, cycle D concern 5 (ruling): a push is a new notice — the bell AND an open Notices list follow it.
  it("a push the worker reports re-reads the count and bumps returnCount (never coalesced with a return)", () => {
    expect(ctx).toContain("noticeReceived: () => void;");
    const received = ctx.slice(ctx.indexOf("const noticeReceived = useCallback"), ctx.indexOf("}, [refreshUnread]);", ctx.indexOf("const noticeReceived = useCallback")));
    expect(received).toContain("void refreshUnread();");
    expect(received).toContain("setReturnCount((n) => n + 1);");
    // A push landing right after a focus return must still reload the list: no coalescing window here.
    expect(received).not.toContain("RETURN_COALESCE_MS");
    expect(received).not.toContain("lastReturn");
    expect(ctx).toMatch(/\(\) => \(\{ unreadCount, returnCount, refreshUnread, setUnreadCount, noticeReceived \}\)/);
  });

  it("the registrar hands the worker's push messages to noticeReceived, so the open list reloads with no skeleton flash", () => {
    const registrar = read("src/components/app/ServiceWorkerRegistrar.tsx");
    expect(registrar).toContain("export function PushMessageListener()");
    expect(registrar).toContain("const { noticeReceived } = useNotifications();");
    expect(registrar).toMatch(/return listenForPushMessages\(noticeReceived\);\s*\}, \[noticeReceived\]\);/);
    // The page reloads on every returnCount bump and keeps the shown list meanwhile (pinned in "Notices page" below).
    expect(src.page).toMatch(/useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load, returnCount\]\);/);
    expect(src.page).not.toContain("setLoaded(null)");
  });
});

describe("app layout (tasks 18–19)", () => {
  it("mounts the provider inside the session, around the chrome (only once a house exists)", () => {
    const layout = src.layout;
    expect(layout).toContain("<NotificationsProvider>");
    // The onboarding branch (no house yet) comes first; the provider only in the house branch.
    const onboarding = layout.indexOf("me.user.groups.length === 0 ? (");
    const provider = layout.indexOf("<NotificationsProvider>");
    expect(onboarding).toBeGreaterThan(-1);
    expect(layout.indexOf("<Onboarding />")).toBeGreaterThan(onboarding);
    expect(provider).toBeGreaterThan(layout.indexOf("<Onboarding />"));
    // Spec 010: the worker's push messages are heard inside the provider (they refresh the bell), next to the chrome;
    // the sync itself runs before the onboarding gate (pinned in ServiceWorkerRegistrar.test.ts).
    expect(layout).toMatch(/<NotificationsProvider>\s*<PushMessageListener \/>\s*<AppChrome>\{children\}<\/AppChrome>\s*<\/NotificationsProvider>/);
  });

  it("starts the install-prompt capture once, from the ROOT layout (the event fires once, possibly on /auth/*)", () => {
    // Chrome fires beforeinstallprompt once after some engagement — a first visit spends it on /auth/login or
    // /auth/register, outside the (app) group, and login only soft-navigates (router.replace). Mounted once.
    const capture = read("src/components/app/InstallPromptCapture.tsx");
    expect(capture).toContain('"use client"');
    expect(capture).toContain("useEffect(() => startInstallPromptCapture(), []);");
    expect(capture).toContain("return null;");
    const root = read("src/app/layout.tsx");
    expect(root).toContain('import { InstallPromptCapture } from "@/components/app/InstallPromptCapture";');
    expect(root.match(/<InstallPromptCapture \/>/g)).toHaveLength(1);
    const callers = [src.layout, src.page, src.context, src.installHook, src.prefs, src.banner, src.sheet, src.chrome];
    for (const source of callers) expect(source).not.toContain("startInstallPromptCapture");
  });

  it("the root layout runs the early-capture script before anything else in <body> (minor 3: event before hydration)", () => {
    const root = read("src/app/layout.tsx");
    expect(root).toContain('import { EARLY_INSTALL_CAPTURE_SCRIPT } from "@/lib/install-prompt";');
    const script = "<script dangerouslySetInnerHTML={{ __html: EARLY_INSTALL_CAPTURE_SCRIPT }} />";
    expect(root.split(script)).toHaveLength(2);
    const body = root.indexOf('<body className="antialiased">');
    expect(body).toBeGreaterThan(-1);
    expect(root.indexOf(script)).toBeGreaterThan(body);
    expect(root.indexOf(script)).toBeLessThan(root.indexOf("<NextIntlClientProvider>"));
  });
});

describe("header bell (task 18, criterion 14)", () => {
  const bell = src.bell;
  const chrome = src.chrome;

  it("links to /notifications with the count in its accessible name", () => {
    expect(bell).toContain('href="/notifications"');
    expect(bell).toContain('aria-label={t("bellCount", { count: unreadCount })}');
    expect(bell).toContain('aria-current={active ? "page" : undefined}');
  });

  it("badge hidden at zero, decorative (the name carries the count), capped at 99+", () => {
    expect(bell).toContain("{unreadCount > 0 && (");
    expect(bell).toMatch(/<span\s+aria-hidden[^>]*>\s*\{badgeText\(unreadCount\)\}/);
  });

  it("a fixed-size target: 44px below md, the header's compact 34px from md (no layout shift when the badge appears)", () => {
    expect(bell).toContain("h-11 w-11");
    expect(bell).toContain("md:h-[2.125rem] md:w-[2.125rem]");
    expect(bell).toContain("absolute");
  });

  it("one bell for mobile and desktop: before the drawer button and before the user menu, never hidden by breakpoint", () => {
    const actions = chrome.slice(chrome.indexOf('<div className="ml-auto flex shrink-0 items-center gap-2">'));
    const bellAt = actions.indexOf("<NotificationBell />");
    expect(bellAt).toBeGreaterThan(-1);
    expect(bellAt).toBeLessThan(actions.indexOf("<UserMenu />"));
    expect(bellAt).toBeLessThan(actions.indexOf("<MobileNavDrawer"));
    expect(chrome).not.toMatch(/hidden[^"]*">\s*<NotificationBell \/>/);
  });

  it("the page is reached from the bell, not from the sidebar/drawer list", () => {
    expect(read("src/components/app/navigation.tsx")).not.toContain("/notifications");
  });
});

describe("Notices page (task 19, criterion 15)", () => {
  const page = src.page;

  it("two real tabs with roving tabindex, arrow/Home/End keys and focusable panels", () => {
    expect(page).toContain('role="tablist"');
    expect(page.match(/role="tab"/g)).toHaveLength(1); // one mapped button
    expect(page).toContain("tabIndex={tab === id ? 0 : -1}");
    for (const key of ['"ArrowRight"', '"ArrowLeft"', '"Home"', '"End"']) expect(page).toContain(key);
    expect(page.match(/role="tabpanel"[^>]*tabIndex=\{0\}/g)).toHaveLength(2);
    for (const label of ['t("tabs.notices")', 't("tabs.preferences")']) expect(page).toContain(label);
  });

  it("All / Unread filter (pressed toggles) loads through the API filter", () => {
    expect(page).toContain("aria-pressed={filter === id}");
    expect(page).toContain('t("filter.all")');
    expect(page).toContain('t("filter.unread")');
    expect(page).toContain("noticesPath(filter)");
  });

  it("loads per active house and filter (never shows another house's list) and hands the count to the bell", () => {
    expect(page).toContain("loaded?.groupId === groupId && loaded?.filter === filter");
    expect(page).toContain("setUnreadCount(data.unreadCount, groupId ?? null)");
  });

  it("drops a list the server read for another house (switched in another tab) and re-reads the session (minor 2)", () => {
    expect(page).toContain("const { activeGroup, membersLoading, refresh: refreshSession } = useSession();");
    const load = page.slice(page.indexOf("const load = useCallback"), page.indexOf("} catch (e) {", page.indexOf("const load = useCallback")));
    const check = load.indexOf("if (answeredForOtherHouse(data.groupId, groupId)) {");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(load.indexOf("setLoaded({ groupId, filter, items: data.notifications"));
    expect(check).toBeLessThan(load.indexOf("setUnreadCount(data.unreadCount"));
    const branch = load.slice(check, load.indexOf("setLoaded({ groupId, filter, items: data.notifications"));
    expect(branch).toContain("void refreshSession().catch(");
    expect(branch).toContain("return;");
  });

  it("reloads the open list when the person comes back to the tab, keeping the shown list (C1, review 1)", () => {
    expect(page).toContain("const { unreadCount, returnCount, setUnreadCount, refreshUnread } = useNotifications();");
    expect(page).toMatch(/useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load, returnCount\]\);/);
    // No reset before the request: the same house + filter keeps `current` (no skeleton flash) …
    expect(page).not.toContain("setLoaded(null)");
    // … and a fresh loadedAt un-freezes the relative times and day groups.
    expect(page).toContain("loadedAt: new Date()");
  });

  it("only the newest mutation's count reaches the bell (answers can arrive out of order)", () => {
    expect(page).toContain("const mutationSeq = useRef(0);");
    for (const fn of ["function openNotice", "async function removeOne", "async function readAll"]) {
      const body = page.slice(page.indexOf(fn), page.indexOf("\n  }\n", page.indexOf(fn)));
      expect(body).toContain("const seq = ++mutationSeq.current;");
      expect(body).toContain("if (seq === mutationSeq.current) setUnreadCount(res.unreadCount, groupId ?? null);");
    }
    expect(page).not.toMatch(/^\s*setUnreadCount\(res\.unreadCount/m);
  });

  it("a late rollback only touches the list of the house the action was taken in (house switched meanwhile)", () => {
    expect(page).toContain("previous?.items && previous.groupId === forGroup");
    const calls = page.match(/setItems\([^,]*,/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call).toBe("setItems(groupId,");
  });

  it("the limit notice comes from the list as loaded (a remove does not hide it)", () => {
    expect(page).toContain("full: isFullList(data.notifications)");
    expect(page).toContain("{current.full && (");
    expect(page).not.toContain("items.length >=");
  });

  it("a mark-read of a notice already gone (404) does not toast on the destination screen", () => {
    const open = page.slice(page.indexOf("function openNotice"), page.indexOf("async function removeOne"));
    expect(open).toContain("void refreshUnread();");
    expect(open).toMatch(/if \(!\(e instanceof ApiError && e\.code === "NOTIFICATION_NOT_FOUND"\)\) toast\(apiErr\(e, t\("actionError"\)\), "error"\);/);
  });

  it("names wait for the new house's members (no previous-house tag, color or dash after a switch)", () => {
    expect(page).toContain("const membersPending = membersLoading;");
    expect(page).toContain("current === null || membersPending ?");
  });

  it("focus lands on the selected tab when the install control that had it goes away", () => {
    expect(page).toContain("const selectedTab = () => document.getElementById(`notices-tab-${tab}`);");
    const start = page.slice(page.indexOf("async function startInstall"), page.indexOf("async function promptFromSheet"));
    // Captured before the one-time prompt removes the banner / the card's button; moved before the sheet opens,
    // so the sheet hands focus back to the tab.
    expect(start.indexOf("const trigger = document.activeElement;")).toBeLessThan(start.indexOf("await install.prompt()"));
    expect(start).toContain("if (trigger instanceof HTMLElement && !trigger.isConnected) selectedTab()?.focus();");
    expect(start.indexOf("selectedTab()?.focus()")).toBeLessThan(start.indexOf('openSheet("installed")'));
    // Sheet closed after its opener left (Android prompt accepted in the sheet, iOS "I've added it").
    expect(page).toContain("fallbackFocus={selectedTab}");
    const notNow = page.slice(page.indexOf("function notNow"));
    expect(notNow).toContain("selectedTab()?.focus();");
  });

  it("Today / Yesterday / Earlier through groupByDay, relative to the moment the list loaded", () => {
    expect(page).toContain("groupByDay(visible, current.loadedAt)");
    expect(page).toContain("t(`group.${group.key}`)");
  });

  it("tap = mark read (optimistic, rollback) and open the related screen", () => {
    const open = page.slice(page.indexOf("function openNotice"));
    expect(open).toContain("setNoticeRead(list, notice.publicId, true)");
    expect(open).toContain("api.patch<NotificationMutationResponse>(`/api/notifications/${notice.publicId}`, { read: true })");
    expect(open).toContain("setNoticeRead(list, notice.publicId, false)");
    expect(open).toContain("router.push(notificationHref(notice.type))");
  });

  it("remove: optimistic, toast on success, rollback + toast on failure (a notice already gone stays gone)", () => {
    const remove = page.slice(page.indexOf("async function removeOne"));
    expect(remove).toContain("api.del<NotificationMutationResponse>(`/api/notifications/${notice.publicId}`)");
    expect(remove).toContain('toast(t("toast.removed"), "success")');
    expect(remove).toContain("restoreNotice(list, notice, index)");
    expect(remove).toContain('e.code === "NOTIFICATION_NOT_FOUND"');
    expect(remove).toContain('apiErr(e, t("actionError"))');
  });

  it("mark all read: optimistic, rollback of exactly the notices that were unread", () => {
    const all = page.slice(page.indexOf("async function readAll"));
    expect(all).toContain('api.post<NotificationMutationResponse>("/api/notifications/read-all")');
    expect(all).toContain("markAllNoticesRead(list)");
    expect(all).toContain("restoreUnread(list, wereUnread)");
    expect(all).toContain('toast(t("toast.allRead"), "success")');
    expect(page).toContain('t("markAllRead")');
  });

  it("every mutation hands the server's count to the bell", () => {
    expect(page.match(/setUnreadCount\(res\.unreadCount, groupId \?\? null\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("limit notice exactly when the list is full; empty states per filter; load error", () => {
    expect(page).toContain('t("limitNotice")');
    expect(page).toContain('t("allCaughtUp")');
    expect(page).toContain('filter === "unread" ? t("emptyUnread") : t("emptyAll")');
    expect(page).toContain('t("loadError")');
  });

  it("title with the unread badge; skeletons and staggered entrances", () => {
    expect(page).toContain('t("title")');
    expect(page).toContain("badgeText(unreadCount)");
    expect(page).toContain("<SkeletonRows");
    expect(page).toContain("revealDelay(");
  });

  it("install banner only when the rules say so; Not now stores the dismissal and says where to install later", () => {
    expect(page).toContain("{install.bannerVisible && (");
    expect(page).toContain("install.dismiss()");
    expect(page).toContain('toast(t("install.notNowToast"), "info")');
  });

  it("Install calls the deferred prompt when the browser has one, otherwise opens the manual steps", () => {
    const start = page.slice(page.indexOf("async function startInstall"));
    expect(start).toContain("if (install.canPrompt)");
    expect(start).toContain("await install.prompt()");
    expect(start).toContain('openSheet("steps")');
  });
});

describe("notice item (task 19, criteria 15–16)", () => {
  const item = src.item;

  it("text per type with the amount in the house currency; names resolved like Activity", () => {
    expect(item).toContain("noticeMessage(notification, {");
    expect(item).toContain("formatMoney(amount, currency, locale)");
    expect(item).toContain('tacc("deletedUserLabel")');
    expect(item).toContain('thh("exMemberLabel", { name })');
    expect(item).toContain('automatic: t("automatic")');
  });

  it("avatar = the person (actor or payer), or the ↻ glyph for an automatic notice", () => {
    expect(item).toContain("noticePersonId(notification)");
    expect(item).toContain('glyph={personId === null ? "↻" : undefined}');
  });

  it("relative time · type label, with the absolute time on the <time> element", () => {
    expect(item).toContain("<time dateTime={notification.createdAt}");
    expect(item).toContain("noticeTimeLabel(notification.createdAt, now, locale)");
    expect(item).toContain("t(`types.${notification.type}.label`)");
  });

  it("unread dot with an accessible label inside the row button", () => {
    expect(item).toContain('<span className="sr-only">{t("unreadDot")}</span>');
  });

  it("row button opens; ✕ removes, named and described by its notice; 44px touch floor below md", () => {
    expect(item).toContain("id={`notice-${notification.publicId}`}");
    expect(item).toContain("onClick={onOpen}");
    expect(item).toContain('aria-label={t("remove")}');
    expect(item).toContain("aria-describedby={textId}");
    expect(item).toContain("onClick={onRemove}");
    expect(item).toContain("min-h-11");
    expect(item).toContain("w-11");
  });

  it("each ✕ is described by its own row's text, like the Recurring card actions (C2)", () => {
    expect(item).toContain("const textId = useId();");
    // Exactly one element carries the id: the notice's text (no time, type or unread label in the description).
    expect(item.match(/id=\{textId\}/g)).toHaveLength(1);
    expect(item).toMatch(/<span id=\{textId\}[^>]*>\s*\{t\(message\.key, message\.values\)\}\s*<\/span>/);
    const remove = item.slice(item.indexOf('aria-label={t("remove")}') - 200, item.indexOf("onClick={onRemove}"));
    expect(remove).toContain("aria-describedby={textId}");
  });
});

describe("preferences (task 19, criteria 9, 13, 15)", () => {
  const prefs = src.prefs;

  it("one switch per NotificationType with its label and description", () => {
    expect(prefs).toContain("NOTIFICATION_TYPES.map((type)");
    expect(prefs).toContain('role="switch"');
    expect(prefs).toContain("aria-checked={on}");
    expect(prefs).toContain("t(`types.${type}.label`)");
    expect(prefs).toContain("t(`types.${type}.description`)");
    expect(prefs).toContain('t("prefsTypes")');
  });

  it("optimistic toggle, PUT { type, enabled }, rollback + toast on error, on/off toasts", () => {
    expect(prefs).toContain('api.put<NotificationPreferencesResponse>("/api/notification-preferences", { type, enabled })');
    expect(prefs).toContain("[type]: !enabled");
    expect(prefs).toContain('t("toast.prefOn", { label })');
    expect(prefs).toContain('t("toast.prefOff", { label })');
    expect(prefs).toContain('apiErr(e, t("prefError"))');
  });

  it("two toggles in flight: each answer applies only its own key (no overwrite of the other's optimistic value)", () => {
    const toggle = prefs.slice(prefs.indexOf("async function toggle"), prefs.indexOf("\n  }\n", prefs.indexOf("async function toggle")));
    expect(toggle).toContain("setPrefs((p) => p && { ...p, [type]: res.preferences[type] });");
    expect(toggle).not.toContain("setPrefs(res.preferences)");
    expect(toggle).toContain("setPrefs((p) => p && { ...p, [type]: !enabled });");
  });

  it("the switch keeps a 44px target below md", () => {
    expect(prefs).toMatch(/role="switch"[\s\S]{0,400}h-11/);
  });

  it("'App on home screen' card: installed / install / prompt used / unsupported", () => {
    expect(prefs).toContain('t("install.cardTitle")');
    expect(prefs).toContain('t("install.cardInstalled")');
    expect(prefs).toContain('t("install.cardBody")');
    expect(prefs).toContain('t("install.unsupported")');
    expect(prefs).toContain('t("install.installedStamp")');
    expect(prefs).toContain('installState === "installed"');
    expect(prefs).toContain('installState === "unsupported"');
    // Install only where it does something (native prompt / iOS steps); after the prompt was used: body, no button.
    expect(prefs).toContain('installState === "prompt" || installState === "manual" ? (');
  });
});

describe("install banner and sheet (task 19, criteria 2–3)", () => {
  it("banner: title, body, Install and Not now", () => {
    for (const key of ['t("install.bannerTitle")', 't("install.bannerBody")', 't("install.install")', 't("install.notNow")']) {
      expect(src.banner).toContain(key);
    }
    expect(src.banner).toContain("onClick={onInstall}");
    expect(src.banner).toContain("onClick={onNotNow}");
  });

  it("sheet: Android / iPhone toggle, the three iOS steps in order, done and installed views, Close", () => {
    const sheet = src.sheet;
    expect(sheet).toContain('title={t("install.sheetTitle")}');
    expect(sheet).toContain('t("install.android")');
    expect(sheet).toContain('t("install.iphone")');
    expect(sheet).toContain("aria-pressed={platform === id}");
    const steps = ["iosStep1", "iosStep2", "iosStep3"].map((k) => sheet.indexOf(`"install.${k}"`));
    expect(steps.every((i) => i > -1)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(sheet).toContain("<ol");
    expect(sheet).toContain('t("install.iosDone")');
    expect(sheet).toContain('t("install.installedStamp")');
    expect(sheet).toContain('t("install.installedBody")');
    expect(sheet).toContain('tc("close")');
  });

  it("sheet, Android tab: native prompt, else the browser-menu step; 'can't install' only where it never can", () => {
    const sheet = src.sheet;
    expect(sheet).toContain('android === "prompt" ? (');
    expect(sheet).toContain('android === "menu" ? (');
    expect(sheet).toContain('t("install.androidMenu")');
    expect(sheet).toContain('t("install.unsupported")');
    expect(sheet).not.toContain("canPrompt");
    expect(src.page).toContain("android={install.sheetAndroid}");
  });

  it("sheet: focus goes to the caller's fallback when the control that opened it is gone", () => {
    expect(src.sheet).toContain("fallbackFocus={fallbackFocus}");
    const modal = read("src/components/ui/Modal.tsx");
    expect(modal).toContain("fallbackFocus?: () => HTMLElement | null;");
    expect(modal).toContain("el && el.isConnected && typeof el.focus === \"function\" ? el : fallbackFocus?.()");
  });

  it("the install state comes from the store and the device, read without hydration mismatches", () => {
    const hook = src.installHook;
    expect(hook).toContain("useSyncExternalStore(subscribeInstallPrompt, getInstallPromptState, getServerInstallPromptState)");
    expect(hook).toContain("isIos(navigator.userAgent, navigator.maxTouchPoints)");
    expect(hook).toContain("isStandalone()");
    expect(hook).toContain("isInstallDismissed()");
    expect(hook).toContain("dismissInstall()");
    expect(hook).toContain("promptInstall()");
    expect(hook).toContain("installBannerVisible(");
    expect(hook).toContain("installCardState(");
    expect(hook).toContain("installSheetAndroid(");
    expect(hook).toContain("const { deferredPrompt, installed, promptUsed } = useSyncExternalStore(");
  });
});

describe("push card (spec 010, task 16; criteria 3, 10, 11)", () => {
  const card = src.pushCard;
  const toggle = card.slice(card.indexOf("async function toggle"), card.indexOf("\n  }\n", card.indexOf("async function toggle")));
  const sendTest = card.slice(card.indexOf("async function sendTest"), card.indexOf("\n  }\n", card.indexOf("async function sendTest")));

  it("sits at the top of the Preferences tab; its iPhone link reuses the install action (the sheet opens on the iPhone tab)", () => {
    expect(src.prefs).toContain('import { PushCard } from "@/components/notifications/PushCard";');
    const at = src.prefs.indexOf("<PushCard onIosHowTo={onInstall} />");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.prefs.indexOf('t("prefsTypes")'));
    // On iPhone/iPad there is never a deferred prompt: Install opens the steps sheet, which starts on the device's tab.
    expect(src.page).toContain("<NotificationPreferences installState={install.cardState} onInstall={() => void startInstall()} />");
    expect(src.page).toContain("ios={install.ios}");
  });

  it("the state comes from push-view; nothing renders while push is unconfigured (criterion 1)", () => {
    expect(card).toContain('"use client"');
    expect(card).toContain("const state = pushCardState({ support, permission, enabled });");
    expect(card).toContain('if (state === "hidden") return null;');
  });

  it("support and permission are read without hydration mismatches; the permission follows the site settings", () => {
    expect(card).toContain("useSyncExternalStore(subscribeNever, pushSupport, serverSupport)");
    expect(card).toContain("useSyncExternalStore(watchNotificationPermission, notificationPermission, serverPermission)");
    expect(card).toContain('const serverSupport = (): PushSupport => "unconfigured";');
    expect(card).toContain('const serverPermission = (): NotificationPermission => "default";');
  });

  it("reads whether push is on here for the signed-in member; a toggle in flight is never overwritten by that read", () => {
    expect(card).toContain("const owner = me?.user.publicId ?? null;");
    expect(card).toContain("pushEnabledHere(owner).then(");
    expect(card.match(/if \(live && !switching\.current\) setEnabled\(/g)).toHaveLength(2);
    expect(card).toContain("}, [support, owner, permission]);");
  });

  it("the switch: role switch, labelled by the title, described by the status, 44px below md", () => {
    expect(card).toContain('role="switch"');
    expect(card).toContain("aria-checked={on}");
    expect(card).toContain('aria-labelledby="push-title"');
    expect(card).toContain('aria-describedby="push-status"');
    expect(card).toMatch(/role="switch"[\s\S]{0,400}h-11 w-14[\s\S]{0,200}md:h-8 md:w-12/);
    expect(card).toContain("{pushSwitchShown(state) && (");
  });

  it("permission is asked only from the tap: subscribePush is the first await of the click handler (iOS user gesture)", () => {
    expect(card).toContain("onClick={() => void toggle()}");
    const firstAwait = toggle.indexOf("await ");
    expect(firstAwait).toBeGreaterThan(-1);
    expect(toggle.slice(firstAwait)).toMatch(/^await subscribePush\(\{ owner, locale \}\)/);
    expect(card).toContain("const locale = useLocale();");
    // Never prompted from anywhere else, never on load.
    expect(card).not.toContain("requestPermission");
    expect(card).not.toContain("syncPush");
  });

  it("optimistic flip, rollback + translated toast on failure (ApiErrors codes such as PUSH_NOT_CONFIGURED), toasts per outcome", () => {
    expect(toggle.indexOf("setEnabled(turnOn);")).toBeLessThan(toggle.indexOf("await "));
    expect(toggle).toContain('setEnabled(outcome === "subscribed");');
    expect(toggle).toContain('if (outcome === "subscribed") toast(t("push.toastOn"), "success");');
    expect(toggle).toContain("await unsubscribePush();");
    expect(toggle).toContain('toast(t("push.toastOff"), "success");');
    expect(toggle).toContain("setEnabled(!turnOn);");
    expect(toggle).toContain('toast(apiErr(e, t("prefError")), "error");');
    expect(toggle).toContain("if (!owner || switching.current || enabled === null) return;");
  });

  // Cycle G review M2: while the browser is asking, the switch is pending (never aria-checked) and the test is disabled;
  // the test also stays disabled for the whole toggle (turning on with permission granted shows "on" before the POST).
  it("asking: the switch shows a pending position, checked only when on; the status says the browser is asking", () => {
    expect(card).toContain("const look = pushSwitchLook(state);");
    expect(card).toContain('const on = look === "on";');
    expect(card).toContain('const pending = look === "pending";');
    expect(card).toContain("aria-checked={on}");
    expect(card).toContain('state === "asking" ? t("push.statusAsking")');
    // Pending: outlined track, knob halfway — distinct from both off and on (cn joins strings: one value per property).
    expect(card).toContain('on ? "border-ink bg-ink" : pending ? "border-ink bg-panel" : "border-rule bg-panel"');
    expect(card).toContain('on ? "translate-x-5 border-paper bg-paper" : pending ? "translate-x-2.5 border-ink bg-card" : "border-rule bg-card"');
  });

  it("a toggle in flight is state too (the test button re-renders disabled), set before the first await and cleared in finally", () => {
    expect(card).toContain("const [toggling, setToggling] = useState(false);");
    expect(toggle.indexOf("setToggling(true);")).toBeGreaterThan(-1);
    expect(toggle.indexOf("setToggling(true);")).toBeLessThan(toggle.indexOf("await "));
    expect(toggle.slice(toggle.indexOf("} finally {"))).toContain("setToggling(false);");
  });

  it("blocked from the prompt: the toast says so and focus moves to the explanation that replaced the switch", () => {
    expect(toggle).toMatch(/else if \(outcome === "denied"\) \{\s*toast\(t\("push\.toastDenied"\), "error"\);\s*(?:\/\/[^\n]*\n\s*)?statusRef\.current\?\.focus\(\);/);
    expect(card).toMatch(/<p\s+id="push-status"\s+ref=\{statusRef\}\s+tabIndex=\{-1\}/);
  });

  it("one status line per state (design › UI)", () => {
    for (const key of ["statusOn", "statusOff", "statusAsk", "statusAsking", "statusDenied", "statusUnsupported", "statusIosInstall"]) {
      expect(card).toContain(`t("push.${key}")`);
    }
    expect(card).toContain('t("push.title")');
  });

  it("iPhone outside the Home Screen app: 'How to add it' opens the install steps, a 44px target below md", () => {
    const link = card.slice(card.indexOf('state === "ios-install" && ('), card.indexOf('t("push.iosHowTo")'));
    expect(link).toContain("onClick={onIosHowTo}");
    expect(link).toContain('aria-haspopup="dialog"');
    expect(link).toContain("min-h-11");
    expect(link).toContain("md:min-h-0");
  });

  it("'Send test notice': POST /api/notifications/test, counts in the toast, enabled only while subscribed", () => {
    expect(sendTest).toContain('api.post<PushTestResult>("/api/notifications/test")');
    expect(sendTest).toContain('toast(t("push.toastTestSent", { sent: res.sent, failed: res.failed }), testResultTone(res));');
    expect(sendTest).toContain('toast(apiErr(e, t("push.testError")), testFailureTone(e instanceof ApiError ? e.status : undefined));');
    expect(card).toContain("disabled={!pushTestEnabled(state, toggling)}");
    expect(card).toContain("{pushTestShown(state) && (");
    expect(card).toContain('t("push.test")');
  });

  it("cooldown (cycle C review minor 4): 10 s from each answer, counted down, the button aria-disabled (keeps focus) meanwhile", () => {
    expect(sendTest).toContain("if (testing.current || cooldown > 0) return;");
    // Started in `finally`, after the answer — success, 429 or any failure: the server counted the tap either way.
    const settled = sendTest.slice(sendTest.indexOf("} finally {"));
    expect(settled).toContain("setCooldown(PUSH_TEST_COOLDOWN_SECONDS);");
    // A one-second chain of timeouts: each fires late, never early, so the wait is never shorter than the server window.
    expect(card).toMatch(/if \(cooldown <= 0\) return;\s*const id = window\.setTimeout\(\(\) => setCooldown\(\(s\) => s - 1\), 1000\);\s*return \(\) => window\.clearTimeout\(id\);\s*\}, \[cooldown\]\);/);
    expect(card).toContain("aria-disabled={testWaiting || undefined}");
    expect(card).toContain('aria-describedby="push-test-hint"');
    expect(card).toContain('cooldown > 0 ? t("push.testWait", { seconds: cooldown }) : t("push.testHint")');
    expect(card).toContain("aria-disabled:cursor-default aria-disabled:opacity-50");
  });

  it("the sending indicator respects reduced motion", () => {
    expect(card).toContain('{sending && <Spinner className="mr-2 motion-reduce:animate-none" />}');
  });

  it("imports no server-only module (the client helpers stay the only browser entry)", () => {
    for (const forbidden of ["@/services", "@/lib/push/endpoint", "@/lib/push/payload", "@/lib/push/schedule", "@/lib/push/config", "web-push", "next/headers", "@/i18n/request"]) {
      expect(card).not.toContain(forbidden);
    }
  });
});

describe("install banner with push configured (spec 010, task 16)", () => {
  it("says the installed app also receives the house's notices once push is configured", () => {
    expect(src.banner).toContain('import { pushConfigured } from "@/lib/push/client";');
    expect(src.banner).toContain('{pushConfigured() ? t("install.bannerBodyPush") : t("install.bannerBody")}');
  });
});
