"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "@/lib/session";
import { api } from "@/lib/api";
import { cn } from "@/components/ui/cn";
import { MemberDot } from "@/components/ui/Member";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { LanguageSelector } from "@/components/app/LanguageSelector";

type IconProps = { className?: string };
const ic = "h-[18px] w-[18px]";

function ReceiptIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3v18l2-1.2L9 21l2-1.2L13 21l2-1.2L17 21l2-1.2V3l-2 1.2L15 3l-2 1.2L11 3 9 4.2 7 3 5 4.2Z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}
function ScaleIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0Zm14 0-3 6a3 3 0 0 0 6 0Z" />
    </svg>
  );
}
function CartIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h2l2.4 12.3a1 1 0 0 0 1 .7h8.7a1 1 0 0 0 1-.8L21 8H6" />
      <circle cx="9" cy="20" r="1.3" /><circle cx="18" cy="20" r="1.3" />
    </svg>
  );
}
function TagIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="7.5" r="1.3" />
    </svg>
  );
}
function HomeIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11 12 4l8 7M6 10v9h12v-9" />
    </svg>
  );
}
function ClockIcon({ className }: IconProps) {
  return (
    <svg className={cn(ic, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  );
}

const NAV = [
  { href: "/despesas", key: "expenses", Icon: ReceiptIcon },
  { href: "/saldos", key: "balances", Icon: ScaleIcon },
  { href: "/compras", key: "shopping", Icon: CartIcon },
  { href: "/plataformas", key: "platforms", Icon: TagIcon },
  { href: "/atividade", key: "activity", Icon: ClockIcon },
  { href: "/casa", key: "household", Icon: HomeIcon },
] as const;

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => pathname === href || pathname.startsWith(href + "/");
}

function CasaSelector() {
  const { me, activeGroup, switchGroup } = useSession();
  const router = useRouter();
  const t = useTranslations("Nav");
  if (!me || !activeGroup) return null;

  return (
    <Menu
      align="start"
      trigger={
        <button className="inline-flex max-w-[42vw] items-center gap-1.5 rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm text-ink transition-colors hover:bg-panel">
          <MemberDot colorIndex={activeGroup.colorIndex} name={activeGroup.name} size={18} />
          <span className="truncate font-medium">{activeGroup.name}</span>
          <span className="text-xs text-faint">▾</span>
        </button>
      }
    >
      <MenuLabel>{t("yourHouses")}</MenuLabel>
      {me.user.groups.map((g) => (
        <MenuItem key={g.id} onSelect={() => g.id !== activeGroup.id && void switchGroup(g.id)}>
          <MemberDot colorIndex={g.colorIndex} name={g.name} size={18} />
          <span className="flex-1 truncate">{g.name}</span>
          {g.id === activeGroup.id && <span className="text-stamp">✓</span>}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onSelect={() => router.push("/casa")}>+ {t("manageHouse")}</MenuItem>
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
        <button className="inline-flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-panel">
          <MemberDot colorIndex={activeGroup?.colorIndex ?? 0} name={me.user.name} size={26} />
          <span className="hidden max-w-28 truncate text-sm text-ink sm:inline">{me.user.name}</span>
        </button>
      }
    >
      <MenuLabel>@{me.user.username}</MenuLabel>
      <MenuItem onSelect={() => router.push("/casa")}>{t("houseAndMembers")}</MenuItem>
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
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <Link href="/despesas" className="font-display text-base font-bold tracking-tight text-ink">
            HOME<span className="text-stamp">SHARE</span>
          </Link>
          <span className="hidden text-faint sm:inline" aria-hidden>·</span>
          <CasaSelector />
          <div className="ml-auto flex items-center gap-2">
            <LanguageSelector />
            <UserMenu />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        {/* Desktop sidebar */}
        <aside className="hidden w-44 shrink-0 md:block">
          <nav className="sticky top-20 flex flex-col gap-1">
            {NAV.map(({ href, key, Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
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

        <main className="min-w-0 flex-1 pb-24 md:pb-6">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-rule bg-paper/95 backdrop-blur md:hidden">
        {NAV.map(({ href, key, Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex min-w-0 flex-col items-center gap-1 px-0.5 py-2 text-[0.55rem] uppercase tracking-tight transition-colors",
              isActive(href) ? "text-stamp" : "text-ink-soft"
            )}
          >
            <Icon />
            <span className="block w-full truncate text-center">{t(key)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
