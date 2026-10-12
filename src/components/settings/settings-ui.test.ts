import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nextConfig from "../../../next.config";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";

// Spec 011. The settings screens are client-only (no DOM environment here), so their contracts are pinned on the
// source, like notifications-ui.test.ts; the theme tokens are checked in src/lib/theme-tokens.test.ts.
const read = (path: string) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : "");
const layout = read("src/app/(app)/settings/layout.tsx");
const index = read("src/app/(app)/settings/page.tsx");
const appearance = read("src/app/(app)/settings/appearance/page.tsx");
const preview = read("src/components/settings/ThemePreview.tsx");
const account = read("src/app/(app)/settings/account/page.tsx");
const security = read("src/app/(app)/settings/security/page.tsx");
const notifications = read("src/app/(app)/settings/notifications/page.tsx");
const notices = read("src/app/(app)/notifications/page.tsx");
const sheet = read("src/components/notifications/InstallSheet.tsx");
const chrome = read("src/components/app/AppChrome.tsx");
const drawer = read("src/components/app/MobileNavDrawer.tsx");

describe("routes (criteria 1, 8)", () => {
  it.each(["/account", "/conta"])("redirects %s straight to /settings/account (permanent, no chain)", async (source) => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(rules.find((rule) => rule.source === source)).toMatchObject({ destination: "/settings/account", permanent: true });
  });

  it("serves the four categories and no longer the old account page", () => {
    for (const page of [appearance, notifications, account, security]) expect(page).toContain("export default function");
    expect(existsSync(join(process.cwd(), "src/app/(app)/account/page.tsx"))).toBe(false);
  });
});

describe("layout: category list (criteria 1, 2)", () => {
  it("lists the four categories in order, with their hint, marking the open one", () => {
    expect(layout).toContain('const CATEGORIES = ["appearance", "notifications", "account", "security"] as const;');
    expect(layout).toContain("href={`/settings/${id}`}");
    expect(layout).toContain('aria-current={active ? "page" : undefined}');
    expect(layout).toContain("t(`categories.${id}.label`)");
    expect(layout).toContain("t(`categories.${id}.hint`)");
  });

  it("below md: the list alone on /settings, the category alone (with a back link) elsewhere; both from md", () => {
    expect(layout).toContain('const isIndex = pathname === "/settings";');
    expect(layout).toContain('isIndex ? "" : "hidden md:block"');
    expect(layout).toContain('isIndex ? "hidden md:block" : ""');
    expect(layout).toMatch(/<Link\s+href="\/settings"\s+className="[^"]*md:hidden/);
  });

  it("on desktop the bare /settings asks to choose a category (owner, 2026-10-08)", () => {
    expect(index).toContain('t("chooseCategory")');
  });
});

describe("appearance (criteria 3, 4, 5)", () => {
  it("one pressed-state card per theme, each with its live preview; a click applies the theme at once", () => {
    expect(appearance).toContain("THEMES.map((option) => (");
    expect(appearance).toContain("aria-pressed={theme === option}");
    expect(appearance).toContain("<ThemePreview theme={option} />");
    const pick = appearance.slice(appearance.indexOf("function pickTheme"));
    expect(pick).toContain("applyThemePreference(next);");
    expect(pick).toContain("setTheme(next);");
  });

  it("starts from the theme on <html> (server-rendered from the cookie), guarded by isTheme", () => {
    expect(appearance).toContain("const current = document.documentElement.dataset.theme;");
    expect(appearance).toContain("if (isTheme(current)) setTheme(current);");
  });

  it("language: the four languages; a pick stores the cookie and re-renders", () => {
    expect(appearance).toContain("LANGUAGES.map((language) => (");
    expect(appearance).toContain("aria-pressed={locale === language.code}");
    const pick = appearance.slice(appearance.indexOf("function pickLocale"));
    expect(pick).toContain("applyLocalePreference(code);");
    expect(pick).toContain("router.refresh();");
  });

  it("the preview is drawn with the theme's own tokens only (a [data-theme] wrapper, no hard-coded colors)", () => {
    expect(preview).toContain("data-theme={theme}");
    for (const token of ["bg-paper", "bg-card", "text-ink", "border-rule", "text-stamp", "font-mono", "font-display"]) {
      expect(preview).toContain(token);
    }
    expect(preview).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(preview).not.toContain("style=");
  });
});

describe("account and security (criterion 7)", () => {
  it("account keeps profile, password (with the push re-sync) and delete; the sessions section moved to security", () => {
    for (const section of ["<ProfileSection", "<PasswordSection hasPassword={me.user.hasPassword} owner={me.user.publicId} />", "<DeleteAccountSection"]) {
      expect(account).toContain(section);
    }
    expect(account).toContain("syncPush({ owner, locale }).catch(() => {});");
    expect(account).not.toContain("logout-all");
    expect(security).toContain('await api.post("/api/auth/logout-all");');
  });
});

describe("notifications (criteria 6, 9)", () => {
  it("settings shows the preferences with the shared install flow", () => {
    expect(notifications).toContain("useInstallFlow(");
    expect(notifications).toContain("<NotificationPreferences installState={install.cardState} onInstall={() => void startInstall()} />");
  });

  it("the Notices page has no tabs any more and links to the settings with a gear", () => {
    expect(notices).not.toContain('role="tablist"');
    expect(notices).not.toContain("NotificationPreferences");
    expect(notices).toContain('href="/settings/notifications"');
    expect(notices).toContain('t("settingsLink")');
    expect(notices).toContain("useInstallFlow(");
  });

  it("one install flow for both screens, in the sheet's module", () => {
    expect(sheet).toContain("export function useInstallFlow(fallbackFocus: () => HTMLElement | null)");
  });
});

describe("entry points (criterion 10)", () => {
  it("avatar menu: a Settings item instead of the theme/language radios; My account opens /settings/account", () => {
    expect(existsSync(join(process.cwd(), "src/components/app/SettingsMenu.tsx"))).toBe(false);
    expect(chrome).not.toContain("SettingsMenu");
    expect(chrome).toContain('router.push("/settings/appearance")');
    expect(chrome).toContain('router.push("/settings/account")');
    expect(chrome).not.toContain('"/account"');
  });

  it("drawer: links to /settings and /settings/account, no settings panel nor theme state", () => {
    expect(drawer).toContain('href="/settings"');
    expect(drawer).toContain('href="/settings/account"');
    expect(drawer).toContain('type DrawerPanel = "main" | "houses";');
    expect(drawer).not.toContain('setPanel("settings")');
    expect(drawer).not.toContain("applyThemePreference");
    expect(drawer).not.toContain('"/account"');
  });
});

describe("texts (criterion 11)", () => {
  it.each([["en", en], ["pt", pt], ["es", es], ["fr", fr]] as const)("%s: the Not now toast points to the settings page", (_, messages) => {
    expect(messages.Notifications.install.notNowToast).toContain(messages.Settings.title);
    expect("tabs" in messages.Notifications).toBe(false);
  });
});
