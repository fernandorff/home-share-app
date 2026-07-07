"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card } from "@/components/ui/Card";
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
import { formatDateLocale } from "@/lib/money";
import type { ActivityResponse, RevisionsResponse, RevisionRecord, Money as MoneyValue } from "@/lib/types";

export default function AtividadePage() {
  const t = useTranslations("Activity");
  const { activeGroup } = useSession();
  const [tab, setTab] = useState<"summary" | "detailed">("summary");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="label-mono text-faint">{t("subtitle")}</p>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      </div>

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
              "rounded-md border px-3 py-1.5 text-[0.7rem] font-display font-bold uppercase tracking-wider transition-colors",
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
  const apiErr = useApiError();
  const { members } = useSession();
  const toast = useToast();
  const locale = useLocale();
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
  const when = (iso: string) => formatWhen(iso, locale);

  const actionLabel = (action: string, entityType: string) => {
    const key = `act.${action}_${entityType}`;
    return t.has(key) ? t(key) : t("act.fallback");
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
        {entries.map((e, i) => (
          <li key={e.id} className="reveal" style={revealDelay(Math.min(i, 12))}>
            {i > 0 && <div className="border-t border-dotted border-rule" />}
            <div className="flex items-start gap-3 py-3">
              <MemberDot colorIndex={colorOf(e.actor?.id)} name={e.actor?.name ?? "?"} size={26} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  <span className="font-medium">{e.actor?.name ?? t("system")}</span>{" "}
                  <span className="text-ink-soft">{actionLabel(e.action, e.entityType)}</span>
                  {e.summary && (
                    <>
                      {" — "}
                      <span className="text-ink">{e.summary}</span>
                    </>
                  )}
                </p>
                {e.action === "UPDATE" && e.changes && (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {Object.entries(e.changes).map(([field, val]) => {
                      const v = val as { from?: unknown; to?: unknown };
                      const label = t.has(`field.${field}`) ? t(`field.${field}`) : field;
                      return (
                        <li key={field} className="tnum text-xs text-faint">
                          {label}: <span className="line-through">{String(v?.from ?? "")}</span>{" → "}
                          <span className="text-ink-soft">{String(v?.to ?? "")}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <span className="mt-1 block text-xs text-faint tnum sm:hidden">{when(e.createdAt)}</span>
              </div>
              <span className="hidden shrink-0 text-xs text-faint tnum sm:block">{when(e.createdAt)}</span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Which fields of each entity's snapshot are worth showing (skips internal ids/timestamps).
const SNAPSHOT_FIELDS: Record<string, string[]> = {
  Expense: ["description", "amount", "date", "payerId", "categories", "platforms", "paymentMethods", "notes"],
  Settlement: ["amount", "date", "fromUserId", "toUserId", "note"],
  ShoppingItem: ["name", "isPurchased"],
  Category: ["name"],
  Platform: ["name"],
  PaymentMethod: ["name"],
};
const HIDDEN_FIELDS = new Set([
  "id", "publicId", "groupId", "createdAt", "updatedAt", "category", "platformId", "platformIds", "password",
]);
const ENTITY_TYPES = ["Expense", "Settlement", "ShoppingItem", "Category", "Platform", "PaymentMethod"] as const;

/** The detailed audit trail (raw EntityRevision snapshots across all entities). */
function DetailedFeed({ groupKey }: { groupKey: number | undefined }) {
  const t = useTranslations("Activity");
  const apiErr = useApiError();
  const { members } = useSession();
  const toast = useToast();
  const locale = useLocale();
  const [revisions, setRevisions] = useState<RevisionRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>(""); // "" = all

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const qs = filter ? `?entityType=${filter}` : "";
        const res = await api.get<RevisionsResponse>(`/api/revisions${qs}`);
        if (alive) setRevisions(res.revisions);
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

  const memberName = (id: unknown) => members.find((m) => m.id === Number(id))?.name ?? `#${id}`;
  const colorOf = (id: number | null) => members.find((m) => m.id === id)?.colorIndex ?? 0;
  const when = (iso: string) => formatWhen(iso, locale);

  const entityLabel = (type: string) => (t.has(`entity.${type}`) ? t(`entity.${type}`) : type);
  const actionLabel = (action: string) => (t.has(`action.${action}`) ? t(`action.${action}`) : action);
  const fieldLabel = (f: string) => (t.has(`field.${f}`) ? t(`field.${f}`) : f);

  const renderValue = (field: string, value: unknown): ReactNode => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return "—";
    if (field === "amount") return <Money value={value as MoneyValue} />;
    if (field === "date") return formatDateLocale(String(value), locale);
    if (typeof value === "boolean") return value ? t("yes") : t("no");
    if (field.endsWith("UserId") || field === "payerId" || field === "addedById") return memberName(value);
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  };

  const snapshotFields = (r: RevisionRecord): string[] => {
    const snap = (r.action === "DELETE" ? r.before : r.after) ?? {};
    const preset = SNAPSHOT_FIELDS[r.entityType];
    const keys = preset ?? Object.keys(snap).filter((k) => !HIDDEN_FIELDS.has(k));
    return keys.filter((k) => {
      const v = (snap as Record<string, unknown>)[k];
      return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== "";
    });
  };

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
            {revisions.map((r, i) => {
              const snap = ((r.action === "DELETE" ? r.before : r.after) ?? {}) as Record<string, unknown>;
              const fields = snapshotFields(r);
              return (
                <li key={r.id} className="reveal" style={revealDelay(Math.min(i, 12))}>
                  {i > 0 && <div className="border-t border-dotted border-rule" />}
                  <div className="flex items-start gap-3 py-3">
                    <MemberDot colorIndex={colorOf(r.actorId)} name={r.actorName ?? "?"} size={26} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">
                        <span className="font-medium">{r.actorName ?? t("system")}</span>{" "}
                        <span className="text-ink-soft">{actionLabel(r.action)}</span>{" "}
                        <span className="text-ink">{entityLabel(r.entityType)}</span>
                      </p>
                      {fields.length > 0 && (
                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                          {fields.map((f) => (
                            <div key={f} className="contents">
                              <dt className="text-xs text-faint">{fieldLabel(f)}</dt>
                              <dd className="min-w-0 break-words text-xs text-ink-soft">{renderValue(f, snap[f])}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      <span className="mt-1 block text-xs text-faint tnum sm:hidden">{when(r.createdAt)}</span>
                    </div>
                    <span className="hidden shrink-0 text-xs text-faint tnum sm:block">{when(r.createdAt)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
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
        "rounded-full border px-2.5 py-1 text-[0.7rem] font-medium transition-colors",
        active ? "border-ink bg-ink text-paper" : "border-rule bg-card text-ink-soft hover:bg-panel"
      )}
    >
      {children}
    </button>
  );
}

function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) +
    " " +
    d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
  );
}
