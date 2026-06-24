"use client";

import { useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Card } from "@/components/ui/Card";
import { MemberDot } from "@/components/ui/Member";
import { EmptyState } from "@/components/ui/Feedback";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { revealDelay } from "@/components/ui/motion";
import { api } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/Toast";
import type { ActivityResponse } from "@/lib/types";

export default function AtividadePage() {
  const t = useTranslations("Activity");
  const apiErr = useApiError();
  const { members, activeGroup } = useSession();
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
        toast(apiErr(err, t("loadError")), "error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup?.id]);

  const colorOf = (id: number | undefined) =>
    members.find((m) => m.id === id)?.colorIndex ?? 0;

  const when = (iso: string) => {
    const d = new Date(iso);
    return (
      d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) +
      " " +
      d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    );
  };

  const actionLabel = (action: string, entityType: string) => {
    const key = `act.${action}_${entityType}`;
    return t.has(key) ? t(key) : t("act.fallback");
  };

  const entries = data?.entries ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="label-mono text-faint">{t("subtitle")}</p>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      </div>

      {loading ? (
        <Card className="overflow-hidden">
          <SkeletonRows rows={8} />
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState title={t("empty")} hint={t("emptyHint")} icon="≡" />
        </Card>
      ) : (
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
                    {/* Mobile: timestamp as a meta line so the action text uses the full width
                        instead of being squeezed by a top-right column. */}
                    <span className="mt-1 block text-xs text-faint tnum sm:hidden">{when(e.createdAt)}</span>
                  </div>
                  <span className="hidden shrink-0 text-xs text-faint tnum sm:block">{when(e.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
