"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { Tag } from "@/components/ui/Stamp";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { cn } from "@/components/ui/cn";
import { useSession } from "@/lib/session";
import { formatMoney } from "@/lib/money";
import { fromCents, toCents } from "@/lib/currency";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { dueDateLabel, equalShareCents, monthName, ruleStatus, shareMembers } from "@/lib/recurring-view";
import type { RecurringExpense } from "@/lib/types";

// Overlapping avatars shown before the "+N" count.
const DOTS_MAX = 6;

/** "↻ monthly" / "↻ recurring" chip. */
export function RecurringTag({ label }: { label: string }) {
  return (
    <Tag>
      <span aria-hidden>↻&nbsp;</span>
      {label}
    </Tag>
  );
}

/**
 * One rule on the Recurring page (spec 008, task 19; criteria 14, 15, 17, 21): amount, day, payer, split,
 * status, then Skip ↔ Undo skip of the next period, Pause ↔ Resume and a ⋯ menu with Edit / Delete — the
 * actions only for the payer or an admin (`canManage`; the routes answer 403 otherwise).
 */
export function RecurringRuleCard({
  rule,
  busy,
  onSkip,
  onUnskip,
  onPause,
  onResume,
  onEdit,
  onDelete,
}: {
  rule: RecurringExpense;
  busy: boolean;
  onSkip: (period: string) => void;
  onUnskip: (period: string) => void;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Recurring");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const locale = useLocale();
  const { me, members, activeGroup } = useSession();
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;

  const payer = members.find((m) => m.id === rule.payerId);
  // Same ex-member / deleted-account treatment as the expense list (BL-16/BL-23).
  const payerName = !payer
    ? "—"
    : payer.deleted
    ? tacc("deletedUserLabel")
    : payer.active
    ? payer.name
    : thh("exMemberLabel", { name: payer.name });
  // The viewer as payer has its own sentence: "You" dropped into everyDay reads "paid by You" / "paga Tú".
  const payerLine =
    rule.payerId === me?.user.id
      ? t("everyDayYou", { day: rule.dayOfMonth })
      : t("everyDay", { day: rule.dayOfMonth, name: payerName });
  const { people, count } = shareMembers(rule, members);
  const share = equalShareCents(toCents(rule.amount), count);
  const status = ruleStatus(rule, new Set(members.filter((m) => m.active).map((m) => m.id)));
  // Card actions read the same on every card ("Skip November"); each one is described by its own rule's name.
  const titleId = useId();
  const next = rule.upcoming[0];

  return (
    <Card className={cn("flex h-full flex-col gap-3 p-4", rule.paused && "border-dashed")}>
      {/* Only the title (+ chip) shares a row with the amount; the payer line below spans the card, so a long
          title never squeezes it into a narrow column beside the amount (C1). */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span id={titleId} className="break-words font-display text-base font-bold text-ink">{rule.description}</span>
            <RecurringTag label={t("monthlyTag")} />
          </p>
          <Money value={rule.amount} className="shrink-0 font-display text-base font-bold" />
        </div>
        <p className="mt-1 text-pretty text-xs text-faint">{payerLine}</p>
      </div>

      <div className="flex items-center gap-2">
        {people.length > 0 && (
          <span className="flex shrink-0 items-center">
            {people.slice(0, DOTS_MAX).map((m, i) => (
              <MemberDot key={m.id} colorIndex={m.colorIndex} name={m.name} size={22} className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")} />
            ))}
            {people.length > DOTS_MAX && <span className="ml-1 text-xs text-faint tnum">+{people.length - DOTS_MAX}</span>}
          </span>
        )}
        {share !== null && (
          <span className="min-w-0 text-xs text-faint tnum">
            {t("perPerson", { count, amount: formatMoney(fromCents(share), currency, locale) })}
          </span>
        )}
      </div>

      <div className="text-xs">
        {status.kind === "memberLeft" && <p className="text-pretty text-debt">{t("pausedMemberLeft")}</p>}
        {status.kind === "paused" && (
          <p className="flex flex-wrap items-center gap-2">
            <Tag>{t("paused")}</Tag>
            <span className="text-faint">{t("pausedNothing")}</span>
          </p>
        )}
        {status.kind === "skipped" && (
          <p className="flex flex-wrap items-center gap-2">
            <Tag>{t("monthSkipped")}</Tag>
            {status.backIn && <span className="text-faint">{t("backIn", { month: monthName(status.backIn, locale) })}</span>}
          </p>
        )}
        {status.kind === "next" && <p className="text-ink-soft tnum">{t("nextPosting", { date: dueDateLabel(status.dueOn) })}</p>}
      </div>

      {rule.canManage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-dotted border-rule pt-3" aria-busy={busy || undefined}>
          {!rule.paused &&
            next &&
            (next.skipped ? (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onUnskip(next.period)} aria-describedby={titleId}>
                {t("undoSkip")}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSkip(next.period)} aria-describedby={titleId}>
                {t("skipMonth", { month: monthName(next.period, locale) })}
              </Button>
            ))}
          {/* Paused because a member left: Resume can only fail (RECURRING_MEMBER_INACTIVE) until the people change. */}
          {status.kind === "memberLeft" ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit} aria-describedby={titleId}>
              {t("edit")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={rule.paused ? onResume : onPause} aria-describedby={titleId}>
              {rule.paused ? t("resume") : t("pause")}
            </Button>
          )}
          <span className="ml-auto">
            <Menu
              align="end"
              trigger={
                <button
                  type="button"
                  aria-label={t("actionsFor", { name: rule.description })}
                  disabled={busy}
                  // 44px touch floor below md, compact from md (like the expense row menu).
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 py-1 text-lg leading-none text-ink-soft transition-colors hover:bg-panel hover:text-ink disabled:opacity-50 md:min-h-0 md:min-w-0"
                >
                  ⋯
                </button>
              }
            >
              <MenuItem onSelect={onEdit}>{t("edit")}</MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={onDelete}>
                {t("delete")}
              </MenuItem>
            </Menu>
          </span>
        </div>
      )}
    </Card>
  );
}
