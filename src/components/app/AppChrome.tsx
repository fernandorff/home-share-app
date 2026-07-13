"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { cn } from "@/components/ui/cn";
import { MemberDot } from "@/components/ui/Member";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { MobileNavDrawer } from "@/components/app/MobileNavDrawer";
import { APP_NAVIGATION } from "@/components/app/navigation";
import { SettingsMenu } from "@/components/app/SettingsMenu";

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(href + "/");
}

function HouseSelector() {
  const { me, activeGroup, switchGroup } = useSession();
  const router = useRouter();
  const t = useTranslations("Nav");
  if (!me || !activeGroup) return null;

  return (
    <Menu
      align="start"
      trigger={
        <button
          // min-h-11: 44px floor on mobile touch (D3/BL-21 — was h34); md:min-h-0 restores the
          // compact desktop size (mouse input).
          className="inline-flex min-h-11 min-w-0 max-w-[34vw] items-center gap-1.5 rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm text-ink transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:min-h-0 md:max-w-[42vw]"
        >
          <MemberDot colorIndex={activeGroup.colorIndex} name={activeGroup.name} size={18} />
          <span className="min-w-0 flex-1 truncate font-medium">{activeGroup.name}</span>
          <span className="text-xs text-faint">▾</span>
        </button>
      }
    >
      <MenuLabel>{t("yourHouses")}</MenuLabel>
      {me.user.groups.map((g) => (
        <MenuItem key={g.id} onSelect={() => g.id !== activeGroup.id && void switchGroup(g.id)}>
          <MemberDot colorIndex={g.colorIndex} name={g.name} size={18} />
          <span className="min-w-0 flex-1 truncate">{g.name}</span>
          {g.id === activeGroup.id && <span className="text-stamp-text">✓</span>}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => router.push("/house")}>+ {t("manageHouse")}</MenuItem>
    </Menu>
  );
}

function UserMenu() {
  const { me, activeGroup } = useSession();
  const router = useRouter();
  const t = useTranslations("Nav");
  if (!me) return null;

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      window.location.href = "/auth/login";
    }
  };

  return (
    <Menu
      align="end"
      trigger={
        <button
          // min-h-11 min-w-11: 44px floor on mobile touch (D3/BL-21 — was h34); md:min-h-0/min-w-0
          // restores the compact desktop size (mouse input).
          className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-panel md:min-h-0 md:min-w-0"
        >
          <MemberDot colorIndex={activeGroup?.colorIndex ?? 0} name={me.user.name} size={26} />
          <span className="hidden max-w-28 truncate text-sm text-ink sm:inline">{me.user.name}</span>
        </button>
      }
    >
      <MenuLabel>@{me.user.username}</MenuLabel>
      <MenuItem onSelect={() => router.push("/account")}>{t("myAccount")}</MenuItem>
      <MenuItem onSelect={() => router.push("/house")}>{t("houseAndMembers")}</MenuItem>
      <MenuSeparator />
      <SettingsMenu />
      <MenuSeparator />
      <MenuItem danger onSelect={logout}>
        {t("logout")}
      </MenuItem>
    </Menu>
  );
}

export function AppChrome({ children }: { children: React.ReactNode }) {
  const isActive = useIsActive();
  const t = useTranslations("Nav");

  return (
    <div className="paper-grain min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-1.5 md:py-3">
          <Link href="/expenses" className="shrink-0 font-display text-base font-bold tracking-tight text-ink">
            HOME<span className="text-stamp">SHARE</span>
          </Link>
          <span className="hidden text-faint md:inline" aria-hidden>·</span>
          <div className="hidden md:block"><HouseSelector /></div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="hidden md:block"><UserMenu /></div>
            <MobileNavDrawer isActive={isActive} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        {/* Desktop sidebar */}
        <aside className="hidden w-44 shrink-0 md:block">
          <nav className="sticky top-20 flex flex-col gap-1">
            {APP_NAVIGATION.map(({ href, key, Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
                  isActive(href)
                    ? "border-ink bg-ink text-paper"
                    : "border-transparent text-ink-soft hover:bg-panel hover:text-ink"
                )}
              >
                <Icon />
                <span className="font-display font-bold uppercase tracking-wide text-[0.74rem]">
                  {t(key)}
                </span>
              </Link>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 pb-6">{children}</main>
      </div>
    </div>
  );
}
