"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { MemberDot } from "@/components/ui/Member";
import { EmptyState } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { cn } from "@/components/ui/cn";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import { formatDateLocale, formatDateTimeLocale, formatMoney } from "@/lib/money";
import {
  actorLabelKey,
  changedFields,
  formatChangeValue,
  isJoinCodeRegeneration,
  keepLastWordTogether,
  membershipPhraseKey,
  periodListLabel,
  revisionFields,
  settlementLine,
  summaryActKey,
  summaryPhrase,
  withSplitField,
  type SplitShareValue,
} from "@/lib/activity-format";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { ACTIVITY_DETAILED_LIMIT, ACTIVITY_SUMMARY_LIMIT, REVISION_ENTITY_TYPES } from "@/lib/constants";
import type { ActivityResponse, RevisionsResponse, RevisionRecord, Money as MoneyValue } from "@/lib/types";

// Reads/writes a single query param while preserving the rest — shared by the tab toggle
// (here) and the entity-type filter (in DetailedFeed) so the Activity view/filter survive a
// reload and can be deep-linked (BL-34).
function useQueryParamSetter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
}

export default function ActivityPage() {
  const t = useTranslations("Activity");
  const { activeGroup } = useSession();
  const searchParams = useSearchParams();
  const setQueryParam = useQueryParamSetter();
  const initialTab = searchParams.get("tab") === "detailed" ? "detailed" : "summary";
  const [tab, setTabState] = useState<"summary" | "detailed">(initialTab);

  function setTab(next: "summary" | "detailed") {
    setTabState(next);
    setQueryParam("tab", next === "detailed" ? "detailed" : "");
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* Tab toggle: high-level feed vs. the raw revision trail. */}
      <div className="flex items-center gap-1">
        {(
          [
            { id: "summary", label: t("tabs.summary") },
            { id: "detailed", label: t("tabs.detailed") },
          ] as const
        ).map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setTab(v.id)}
            aria-pressed={tab === v.id}
            className={cn(
              // ring-inset so keyboard focus is visible on the segmented toggle (a11y WCAG 2.4.7).
              "min-h-11 rounded-md border px-3 py-1.5 text-xs font-display font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-0",
              tab === v.id
                ? "border-ink bg-ink text-paper"
                : "border-rule bg-card text-ink-soft hover:bg-panel"
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {tab === "summary" ? (
        <SummaryFeed groupKey={activeGroup?.id} />
      ) : (
        <DetailedFeed groupKey={activeGroup?.id} />
      )}
    </div>
  );
}

/** The high-level activity feed (manual AuditLog entries). */
function SummaryFeed({ groupKey }: { groupKey: number | undefined }) {
  const t = useTranslations("Activity");
  const tc = useTranslations("Common");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const apiErr = useApiError();
  const { members, activeGroup } = useSession();
  const toast = useToast();
  const locale = useLocale();
  const currency = activeGroup?.currency ?? DEFAULT_CURRENCY;
  const fmt = {
    money: (v: MoneyValue) => formatMoney(v, currency, locale),
    yes: t("yes"),
    no: t("no"),
  };
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<ActivityResponse>("/api/activity");
        if (alive) setData(res);
      } catch (err) {
        if (alive) toast(apiErr(err, t("loadError")), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey]);

  const colorOf = (id: number | undefined) => members.find((m) => m.id === id)?.colorIndex ?? 0;
  const when = formatDateTimeLocale;

  // Who an actor id resolves to (BL-16/BL-23): a deleted account always shows the fully
  // translated label (the raw name column is just a neutral placeholder); an ex-member keeps
  // their real name, just tagged.
  const displayName = (id: number | undefined, fallback: string) => {
    if (id === undefined) return fallback;
    const m = members.find((mm) => mm.id === id);
    if (!m) return fallback;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };

  const actionLabel = (action: string, entityType: string) => {
    const key = `act.${action}_${entityType}`;
    return t.has(key) ? t(key) : t("act.fallback");
  };

  // Spec 008: a recurring rule's edit records raw ids and enum codes (payerId, participantIds, splitMode).
  const changeFmt = {
    ...fmt,
    member: (id: number) => displayName(id, `#${id}`),
    enumValue: (field: string, value: string) => (t.has(`${field}Value.${value}`) ? t(`${field}Value.${value}`) : value),
  };

  // A settlement's `summary` is a "Name → Name" string baked in at the moment it was recorded —
  // it never updates if either person later leaves/is removed (BL-16) or deletes their account
  // (BL-23). Reconstruct it from the involved userIds (recorded in `changes` for this reason) so
  // an ex-member/deleted account shows correctly here too; falls back to the stored string for
  // entries recorded before this fix (no fromUserId/toUserId in `changes` yet) and for every
  // other entity type, whose `summary` isn't a name pair.
  const resolvedSummary = (e: (typeof entries)[number]): string => {
    // R2-26: a house update's stored summary is the new currency code ("— BRL" read as the house's
    // name); the house is always the active one and the change line below names the currency.
    if (e.entityType === "GROUP") return "";
    if (e.entityType === "SETTLEMENT" && e.changes) {
      const from = e.changes.fromUserId;
      const to = e.changes.toUserId;
      if (typeof from === "number" && typeof to === "number") {
        const fromM = members.find((m) => m.id === from);
        const toM = members.find((m) => m.id === to);
        // R3-22: the amount tells repeated "recorded a payment — Bruno QA → Ana QA" rows apart;
        // settlementLine also keeps each surname with its first name (R3-23).
        const amount = e.changes.amount;
        return settlementLine(
          displayName(from, fromM?.name ?? "?"),
          displayName(to, toM?.name ?? "?"),
          typeof amount === "string" || typeof amount === "number" ? fmt.money(amount) : null
        );
      }
    }
    return e.summary;
  };

  const entries = data?.entries ?? [];

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <SkeletonRows rows={8} inset />
      </Card>
    );
  }
  if (entries.length === 0) {
    return (
      <Card>
        <EmptyState title={t("empty")} hint={t("emptyHint")} icon="≡" />
      </Card>
    );
  }

  return (
    <Card>
      <ul className="px-5 py-1">
        {entries.map((e, i) => {
          // formatChangeValue hides technical fields (e.g. linkedExpenseIds) entirely and formats
          // the rest by type (money/boolean) instead of the raw `String(value)` (B7); a field with
          // no translation is hidden too, rather than printing its raw key.
          const changeRows =
            e.action === "UPDATE" && e.changes
              ? Object.entries(e.changes)
                  .filter(([field]) => t.has(`field.${field}`))
                  .map(([field, val]) => {
                    const v = val as { from?: unknown; to?: unknown };
                    return {
                      field,
                      from: formatChangeValue(field, v?.from, changeFmt),
                      to: formatChangeValue(field, v?.to, changeFmt),
                    };
                  })
                  .filter((r): r is { field: string; from: string; to: string } => r.from !== null && r.to !== null)
                  // M5: a row that reads the same on both sides ("BRL → BRL", written before R2-08 stopped
                  // recording same-currency picks) says nothing.
                  .filter((r) => r.from !== r.to)
              : [];
          // R2-03: entries the generic act.<ACTION>_<TYPE> can't describe (expense links) get their own phrase.
          const phrase = summaryPhrase(e, locale);
          // Spec 008: a recurring posting has no actor — "Automatic" (any other actor-less entry stays "Someone").
          const actorKey = actorLabelKey({ actorId: e.actor?.id ?? null, entityType: e.entityType, action: e.action, changes: e.changes });
          const actorName = displayName(e.actor?.id, e.actor?.name ?? t(actorKey));
          return (
            <li key={e.id} className="reveal" style={revealDelay(Math.min(i, 12))}>
              {i > 0 && <div className="border-t border-dotted border-rule" />}
              <div className="flex items-start gap-3 py-3">
                <MemberDot
                  colorIndex={colorOf(e.actor?.id)}
                  name={actorKey === "automatic" ? actorName : displayName(e.actor?.id, e.actor?.name ?? "?")}
                  glyph={actorKey === "automatic" ? "↻" : undefined}
                  size={26}
                />
                <div className="min-w-0 flex-1">
                  {/* R3-23: a surname never splits from the name before it ("Ana / QA"; a long name still wraps) and the dash stays at the end of its line, never opening the next. */}
                  <p className="break-words text-pretty text-sm text-ink">
                    <span className="font-medium">{keepLastWordTogether(actorName)}</span>{" "}
                    <span className="text-ink-soft">{phrase ? t(phrase.key, phrase.values) : actionLabel(e.action, e.entityType)}</span>
                    {resolvedSummary(e) && (
                      <>
                        {"\u00a0— "}
                        <span className="text-ink">{resolvedSummary(e)}</span>
                      </>
                    )}
                  </p>
                  {changeRows.length > 0 && (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {changeRows.map((r) => (
                        <li key={r.field} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1 tnum text-xs text-faint">
                          {/* R3-07: label column + value column (the History's R2-15 layout) — a long
                              "old → new" wraps under the old value and the arrow travels with the new one.
                              R3-27: the label's colon comes from the locale (fr "devise :"). */}
                          <span>{tc("labelColon", { label: t(`field.${r.field}`) })}</span>
                          <span className="min-w-0">
                            <span className="line-through">{r.from}</span>{" →\u00a0"}
                            <span className="text-ink-soft">{r.to}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <span className="mt-1 block text-xs text-faint tnum sm:hidden">{when(e.createdAt)}</span>
                </div>
                <span className="hidden shrink-0 text-xs text-faint tnum sm:block">{when(e.createdAt)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {data?.hasMore && (
        <p className="border-t border-dotted border-rule px-5 py-3 text-center text-pretty text-xs text-faint">
          {t("limitNotice", { count: ACTIVITY_SUMMARY_LIMIT })}
        </p>
      )}
    </Card>
  );
}

// Which fields of each entity's snapshot are worth showing (skips internal ids/timestamps).
const SNAPSHOT_FIELDS: Record<string, string[]> = {
  // `split` is a pseudo-field built from the snapshot's `participants` (withSplitField, I4).
  Expense: ["description", "amount", "date", "payerId", "split", "categories", "platforms", "paymentMethods", "notes"],
  Settlement: ["amount", "date", "fromUserId", "toUserId", "note"],
  ShoppingItem: ["name", "isPurchased", "linkedExpenses"],
  Category: ["name"],
  Platform: ["name"],
  PaymentMethod: ["name"],
  // colorIndex deliberately excluded — pure internal styling detail, no user-facing meaning (BL-19).
  GroupMember: ["userId", "role"],
  Group: ["name", "currency"],
  // Spec 008: the rule's own fields; activeFrom/timezone/createdById stay out (internal bookkeeping).
  RecurringExpense: [
    "description", "amount", "dayOfMonth", "payerId", "splitMode", "participantIds", "pausedAt", "pauseReason", "skippedPeriods",
  ],
};
const HIDDEN_FIELDS = new Set([
  "id", "publicId", "groupId", "createdAt", "updatedAt", "category", "platformId", "platformIds", "password",
]);
const ENTITY_TYPES = REVISION_ENTITY_TYPES;
// Categories/platforms/payment methods store a system i18n key ("groceries") or a house custom
// name ("Streaming") with no marker distinguishing them — same fallback pattern as balances/page.tsx.
const TAG_FIELD_NS: Record<string, string> = { categories: "category", platforms: "platform", paymentMethods: "payment" };

/** The detailed audit trail (raw EntityRevision snapshots across all entities). */
function DetailedFeed({ groupKey }: { groupKey: number | undefined }) {
  const t = useTranslations("Activity");
  const tExp = useTranslations("Expenses");
  const thh = useTranslations("Household");
  const tacc = useTranslations("Account");
  const apiErr = useApiError();
  const { members } = useSession();
  const toast = useToast();
  const searchParams = useSearchParams();
  const setQueryParam = useQueryParamSetter();
  const locale = useLocale();
  const [revisions, setRevisions] = useState<RevisionRecord[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  // "" = all. Seeded from the URL so a reload/deep-link keeps the same filter (BL-34).
  const filterParam = searchParams.get("filter");
  const [filter, setFilterState] = useState<string>(
    filterParam && (ENTITY_TYPES as readonly string[]).includes(filterParam) ? filterParam : ""
  );

  function setFilter(next: string) {
    setFilterState(next);
    setQueryParam("filter", next);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const qs = filter ? `?entityType=${filter}` : "";
        const res = await api.get<RevisionsResponse>(`/api/revisions${qs}`);
        if (alive) {
          setRevisions(res.revisions);
          setHasMore(res.hasMore);
        }
      } catch (err) {
        if (alive) toast(apiErr(err, t("loadError")), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, filter]);

  // Field-value lookup (e.g. "payerId changed to X") AND actor-name lookup share the same
  // ex-member/deleted-account treatment as balances/page.tsx's displayName (BL-16/BL-23).
  const memberName = (id: unknown) => {
    const m = members.find((mm) => mm.id === Number(id));
    if (!m) return `#${id}`;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };
  const displayName = (id: number | null, fallback: string) => {
    if (id === null) return fallback;
    const m = members.find((mm) => mm.id === id);
    if (!m) return fallback;
    if (m.deleted) return tacc("deletedUserLabel");
    if (!m.active) return thh("exMemberLabel", { name: m.name });
    return m.name;
  };
  const colorOf = (id: number | null) => members.find((m) => m.id === id)?.colorIndex ?? 0;
  const when = formatDateTimeLocale;

  const entityLabel = (type: string) => (t.has(`entity.${type}`) ? t(`entity.${type}`) : type);
  // Lowercase noun WITH its article ("a payment method"), for the mid-sentence slot below
  // (B7: "deleted Payment method" read as a capitalized fragment, not a sentence).
  const entityWithArticle = (type: string) =>
    t.has(`entityArticle.${type}`) ? t(`entityArticle.${type}`) : entityLabel(type).toLowerCase();
  const actionLabel = (action: string) => (t.has(`action.${action}`) ? t(`action.${action}`) : action);
  const fieldLabel = (f: string) => (t.has(`field.${f}`) ? t(`field.${f}`) : f);

  // `struck` marks the old side of a change: a share is an atomic inline-block, so the old value's
  // line-through (on the wrapper) does not reach it and each share carries its own.
  const renderValue = (field: string, value: unknown, struck = false): ReactNode => {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "—";
    if (field === "amount") return <Money value={value as MoneyValue} />;
    if (field === "date") return formatDateLocale(String(value));
    if (typeof value === "boolean") return value ? t("yes") : t("no");
    if (field === "pausedAt") return when(String(value));
    if (field === "splitMode" || field === "pauseReason") {
      const key = `${field}Value.${value}`;
      return t.has(key) ? t(key) : String(value);
    }
    if (field === "participantIds" && Array.isArray(value)) return value.map((id) => memberName(id)).join(", ");
    // Spec 008: skipped months as "November 2026", not the stored "2026-11".
    if (field === "skippedPeriods" && Array.isArray(value)) return periodListLabel(value, locale);
    if (field === "userId" || field.endsWith("UserId") || field === "payerId" || field === "addedById") return memberName(value);
    if (field === "role") return t.has(`roleValue.${value}`) ? t(`roleValue.${value}`) : String(value);
    if (field === "split") {
      return (value as SplitShareValue[]).map((s, i) => (
        <Fragment key={s.userId}>
          {i > 0 && "\u00a0· "}
          {/* R3-07: a share never breaks between the name and its amount (U+00A0) and moves to the next line
              whole when it fits; one longer than the line wraps inside its own box instead of overflowing.
              The U+00A0 before "·" keeps a line from opening with the separator. */}
          <span className={cn("inline-block max-w-full break-words align-top", struck && "line-through")}>
            {memberName(s.userId)}{"\u00a0"}<Money value={s.amount} />
          </span>
        </Fragment>
      ));
    }
    if (Array.isArray(value)) {
      const ns = TAG_FIELD_NS[field];
      if (!ns) return value.join(", ");
      return (value as string[])
        .map((v) => (tExp.has(`${ns}.${v}`) ? tExp(`${ns}.${v}`) : v))
        .join(", ");
    }
    return String(value);
  };

  // Current non-empty fields, plus (UPDATE) fields that were filled and got cleared — see revisionFields.
  const snapshotFields = (r: RevisionRecord): string[] =>
    revisionFields(r, SNAPSHOT_FIELDS[r.entityType], HIDDEN_FIELDS);

  return (
    <div className="flex flex-col gap-4">
      {/* Entity-type filter */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip active={filter === ""} onClick={() => setFilter("")}>
          {t("filterAll")}
        </FilterChip>
        {ENTITY_TYPES.map((type) => (
          <FilterChip key={type} active={filter === type} onClick={() => setFilter(type)}>
            {entityLabel(type)}
          </FilterChip>
        ))}
      </div>

      {loading ? (
        <Card className="overflow-hidden">
          <SkeletonRows rows={8} inset />
        </Card>
      ) : !revisions || revisions.length === 0 ? (
        <Card>
          <EmptyState title={t("detailedEmpty")} hint={t("detailedEmptyHint")} icon="≡" />
        </Card>
      ) : (
        <Card>
          <ul className="px-5 py-1">
            {revisions.map((rev, i) => {
              // I4: an Expense's participants become the `split` pseudo-field before anything reads the snapshots.
              const r = withSplitField(rev);
              const snap = ((r.action === "DELETE" ? r.before : r.after) ?? {}) as Record<string, unknown>;
              // R3-19: a join-code regeneration carries only a marker (never the code): its own phrase,
              // and none of the unchanged name/currency rows that would read as the change.
              const codeRegen = isJoinCodeRegeneration(r);
              const fields = codeRegen ? [] : snapshotFields(r);
              // UPDATEs carry a before (explicit, or the previous revision's after — R2-09) → "old → new".
              const prev = r.action === "UPDATE" && r.before ? (r.before as Record<string, unknown>) : null;
              // R2-27: membership events read as people joining/being added, not "created a membership".
              const phraseKey = codeRegen ? "act.REGENERATE_CODE" : membershipPhraseKey(r);
              // R3-20: everything else uses the Summary's phrase for the same event whenever it has one.
              const actKey = summaryActKey(r.action, r.entityType);
              // R2-09: an update where no shown field (cleared ones included) differs from the previous
              // state (e.g. a new join code).
              const changed = prev ? changedFields(prev, snap, fields) : [];
              // A phrase already says what happened (left the house, rejoined…), so it needs no "nothing changed" line.
              const unchanged = prev !== null && changed.length === 0 && !phraseKey;
              // Spec 008: a recurring posting has no actor — "Automatic" (any other actor-less revision stays "Someone").
              const actorKey = actorLabelKey({ actorId: r.actorId, entityType: r.entityType, action: r.action, after: r.after });
              const actorName = displayName(r.actorId, r.actorName ?? t(actorKey));
              return (
                <li key={r.id} className="reveal" style={revealDelay(Math.min(i, 12))}>
                  {i > 0 && <div className="border-t border-dotted border-rule" />}
                  <div className="flex items-start gap-3 py-3">
                    <MemberDot
                      colorIndex={colorOf(r.actorId)}
                      name={actorKey === "automatic" ? actorName : displayName(r.actorId, r.actorName ?? "?")}
                      glyph={actorKey === "automatic" ? "↻" : undefined}
                      size={26}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-pretty text-sm text-ink">
                        <span className="font-medium">{keepLastWordTogether(actorName)}</span>{" "}
                        {phraseKey ? (
                          <span className="text-ink-soft">{t(phraseKey)}</span>
                        ) : t.has(actKey) ? (
                          <span className="text-ink-soft">{t(actKey)}</span>
                        ) : (
                          <>
                            <span className="text-ink-soft">{actionLabel(r.action)}</span>{" "}
                            <span className="text-ink">{entityWithArticle(r.entityType)}</span>
                          </>
                        )}
                      </p>
                      {fields.length > 0 && (
                        // Mobile: label stacked above its value (a fixed-width label column squeezed
                        // long values into many lines, D21). Desktop keeps the two-column layout.
                        // R3-24: one 10rem label column for every entry (an auto column per entry started the
                        // values at a different x on each row).
                        <dl className="mt-1 flex flex-col gap-y-1 sm:grid sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-2 sm:gap-y-0.5">
                          {fields.map((f) => (
                            <div key={f} className="sm:contents">
                              <dt className="text-xs text-faint">{fieldLabel(f)}</dt>
                              <dd className="min-w-0 break-words text-xs text-ink-soft">
                                {prev && changed.includes(f) ? (
                                  <>
                                    <span className="line-through">{renderValue(f, prev[f], true)}</span>{" "}
                                    {/* R3-07: the arrow and the new value are one box, so the arrow never ends a line
                                        while its value starts the next (a soft wrap next to an inline-block survives U+00A0). */}
                                    <span className="inline-block max-w-full break-words align-top">
                                      {"→\u00a0"}{renderValue(f, snap[f])}
                                    </span>
                                  </>
                                ) : (
                                  renderValue(f, snap[f])
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {unchanged && <p className="mt-1 text-xs text-faint">{t("noVisibleChange")}</p>}
                      <span className="mt-1 block text-xs text-faint tnum sm:hidden">{when(r.createdAt)}</span>
                    </div>
                    <span className="hidden shrink-0 text-xs text-faint tnum sm:block">{when(r.createdAt)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {/* R3-21: same notice as the Summary — older revisions exist beyond this page. */}
          {hasMore && (
            <p className="border-t border-dotted border-rule px-5 py-3 text-center text-pretty text-xs text-faint">
              {t("limitNotice", { count: ACTIVITY_DETAILED_LIMIT })}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // min-h-11: 44px touch floor on mobile (A3 — was 26px); md:min-h-8 restores the compact desktop size.
        // R3-25: square and uppercase like the Summary/Detailed toggle above (was a rounded pill in mixed
        // case). R3-26: min-w-11 — "All" was 43px wide.
        "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-2.5 py-1 font-display text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stamp md:min-h-8",
        active ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
      )}
    >
      {children}
    </button>
  );
}
