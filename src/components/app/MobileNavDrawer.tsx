"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_NAVIGATION } from "@/components/app/navigation";
import { MemberDot } from "@/components/ui/Member";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { LANGUAGES, applyLocalePreference, applyThemePreference } from "@/lib/client-preferences";
import { useSession } from "@/lib/session";
import { DEFAULT_THEME, THEMES, isTheme, type Theme } from "@/lib/theme";

type DrawerPanel = "main" | "houses" | "settings";

export function MobileNavDrawer({ isActive }: { isActive: (href: string) => boolean }) {
  const { me, activeGroup, switchGroup } = useSession();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("Nav");
  const tc = useTranslations("Common");
  const tt = useTranslations("Theme");
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<DrawerPanel>("main");
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [switchingGroupId, setSwitchingGroupId] = useState<number | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (isTheme(current)) setTheme(current);
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => event.matches && setOpen(false);
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  if (!me || !activeGroup) return null;

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) setPanel("main");
  }

  async function pickGroup(groupId: number) {
    if (groupId === activeGroup?.id) {
      setPanel("main");
      return;
    }
    setSwitchingGroupId(groupId);
    try {
      await switchGroup(groupId);
      setPanel("main");
    } finally {
      setSwitchingGroupId(null);
    }
  }

  function pickTheme(next: Theme) {
    applyThemePreference(next);
    setTheme(next);
  }

  function pickLocale(code: string) {
    applyLocalePreference(code);
    router.refresh();
  }

  async function logout() {
    try {
      await api.post("/api/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  }

  const title = panel === "houses" ? t("yourHouses") : panel === "settings" ? t("settings") : t("menu");

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={t("openMenu")}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-ink bg-card text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:hidden"
        >
          <svg aria-hidden className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-ink/40 backdrop-blur-[1px] md:hidden" />
        <Dialog.Content
          aria-modal
          aria-describedby={undefined}
          className="anim-drawer fixed inset-y-0 right-0 z-50 flex h-dvh w-[88vw] max-w-sm flex-col border-l border-ink bg-card shadow-[-4px_0_0_rgba(22,20,15,0.16)] focus:outline-none md:hidden"
        >
          <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-dashed border-rule px-3">
            {panel !== "main" && (
              <button
                type="button"
                aria-label={t("back")}
                onClick={() => setPanel("main")}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
              >
                <span aria-hidden>←</span>
              </button>
            )}
            <Dialog.Title className="min-w-0 flex-1 truncate font-display text-sm font-bold uppercase tracking-wider text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={tc("close")}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-lg text-faint transition-colors hover:bg-panel hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
            >
              <span aria-hidden>✕</span>
            </Dialog.Close>
          </div>

          {panel === "main" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="flex items-center gap-3 border-b border-dotted border-rule px-4 py-4">
                <MemberDot colorIndex={activeGroup.colorIndex} name={me.user.name} size={34} />
                <span className="min-w-0">
                  <span className="block truncate font-display text-sm font-bold text-ink">{me.user.name}</span>
                  <span className="block truncate text-xs text-faint">@{me.user.username}</span>
                </span>
              </div>

              <div className="border-b border-dashed border-rule p-3">
                <p className="label-mono px-2 pb-1.5">{t("activeHouse")}</p>
                <button
                  type="button"
                  onClick={() => setPanel("houses")}
                  className="flex min-h-12 w-full min-w-0 items-center gap-2.5 rounded-md border border-rule bg-panel px-3 text-left text-ink transition-colors hover:border-ink hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                >
                  <MemberDot colorIndex={activeGroup.colorIndex} name={activeGroup.name} size={22} />
                  <span className="min-w-0 flex-1 truncate font-medium">{activeGroup.name}</span>
                  <span className="text-faint" aria-hidden>›</span>
                </button>
              </div>

              <nav aria-label={t("menu")} className="flex flex-col gap-1 p-3">
                {APP_NAVIGATION.map(({ href, key, Icon }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "flex min-h-12 items-center gap-3 rounded-md border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink",
                        active
                          ? "border-ink bg-ink text-paper"
                          : "border-transparent text-ink-soft hover:bg-panel hover:text-ink"
                      )}
                    >
                      <Icon />
                      <span className="font-display font-bold uppercase tracking-wide text-[0.74rem]">{t(key)}</span>
                    </Link>
                  );
                })}
              </nav>

              <div className="mt-auto border-t border-dashed border-rule p-3">
                <Link
                  href="/account"
                  onClick={() => setOpen(false)}
                  className="flex min-h-12 items-center rounded-md px-3 text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                >
                  {t("myAccount")}
                </Link>
                <button
                  type="button"
                  onClick={() => setPanel("settings")}
                  className="flex min-h-12 w-full items-center justify-between rounded-md px-3 text-left text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                >
                  <span>{t("settings")}</span>
                  <span className="text-faint" aria-hidden>›</span>
                </button>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex min-h-12 w-full items-center rounded-md px-3 text-left text-sm text-debt transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                >
                  {t("logout")}
                </button>
              </div>
            </div>
          )}

          {panel === "houses" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
              <div className="flex flex-col gap-1">
                {me.user.groups.map((group) => {
                  const active = group.id === activeGroup.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      disabled={switchingGroupId !== null}
                      aria-pressed={active}
                      onClick={() => void pickGroup(group.id)}
                      className="flex min-h-12 min-w-0 items-center gap-3 rounded-md px-3 text-left text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink disabled:opacity-50"
                    >
                      <MemberDot colorIndex={group.colorIndex} name={group.name} size={22} />
                      <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      {active && <span className="text-stamp-text" aria-hidden>✓</span>}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push("/house");
                }}
                className="mt-3 flex min-h-12 items-center rounded-md border border-dashed border-rule px-3 text-left text-sm text-ink transition-colors hover:border-ink hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
              >
                + {t("manageHouse")}
              </button>
            </div>
          )}

          {panel === "settings" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <fieldset>
                <legend className="label-mono px-3 py-2">{tt("label")}</legend>
                <div className="flex flex-col gap-1">
                  {THEMES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={theme === option}
                      onClick={() => pickTheme(option)}
                      className="flex min-h-12 items-center justify-between rounded-md px-3 text-left text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                    >
                      <span>{tt(option)}</span>
                      {theme === option && <span className="text-stamp-text" aria-hidden>✓</span>}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="my-3 border-t border-dashed border-rule" />

              <fieldset>
                <legend className="label-mono px-3 py-2">{tc("language")}</legend>
                <div className="flex flex-col gap-1">
                  {LANGUAGES.map((language) => (
                    <button
                      key={language.code}
                      type="button"
                      aria-pressed={locale === language.code}
                      onClick={() => pickLocale(language.code)}
                      className="flex min-h-12 items-center justify-between rounded-md px-3 text-left text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                    >
                      <span>{language.label}</span>
                      {locale === language.code && <span className="text-stamp-text" aria-hidden>✓</span>}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
