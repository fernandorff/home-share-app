"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api";
import { useApiError } from "@/lib/api-errors";
import { useSession } from "@/lib/session";
import {
  notificationPermission,
  pushEnabledHere,
  pushSupport,
  subscribePush,
  unsubscribePush,
  watchNotificationPermission,
  type PushSupport,
} from "@/lib/push/client";
import {
  PUSH_TEST_COOLDOWN_SECONDS,
  pushCardState,
  pushSwitchLook,
  pushSwitchShown,
  pushTestEnabled,
  pushTestShown,
  testFailureTone,
  testResultTone,
  type PushTestResult,
} from "@/lib/push-view";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Feedback";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/components/ui/cn";

// The device and its push support do not change while the page is open (an install reopens as the standalone app).
const subscribeNever = () => () => {};
// Server snapshots: nothing to offer, so hydration never disagrees with the server render.
const serverSupport = (): PushSupport => "unconfigured";
const serverPermission = (): NotificationPermission => "default";

/**
 * "Receive on this device" (spec 010, task 16; criteria 3, 10, 11), at the top of the Preferences tab. The switch asks
 * for permission only from the member's tap; where push cannot work it explains why instead (iPhone: a link to the
 * install steps); "Send test notice" works while this device is subscribed and waits 10 s after each send. Hidden
 * while push is unconfigured.
 */
export function PushCard({ onIosHowTo }: { onIosHowTo: () => void }) {
  const t = useTranslations("Notifications");
  const apiErr = useApiError();
  const toast = useToast();
  const locale = useLocale();
  const { me } = useSession();
  const owner = me?.user.publicId ?? null;
  const support = useSyncExternalStore(subscribeNever, pushSupport, serverSupport);
  const permission = useSyncExternalStore(watchNotificationPermission, notificationPermission, serverPermission);
  // Push is on here for this member: null until read from the browser; flipped optimistically by the switch.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // Synchronous double-tap guards.
  const switching = useRef(false);
  const testing = useRef(false);
  // The toggle in flight as state, so the test button re-renders disabled for all of it (cycle G review, M2).
  const [toggling, setToggling] = useState(false);
  const [sending, setSending] = useState(false);
  // Seconds before another test may go out (the server allows one per 10 s and counts refused taps too).
  const [cooldown, setCooldown] = useState(0);
  const statusRef = useRef<HTMLParagraphElement>(null);

  // Read again when the permission changes (site settings); a toggle in flight owns the value until it settles.
  useEffect(() => {
    if (support !== "ok" || !owner) return;
    let live = true;
    pushEnabledHere(owner).then(
      (on) => {
        if (live && !switching.current) setEnabled(on);
      },
      () => {
        if (live && !switching.current) setEnabled(false);
      }
    );
    return () => {
      live = false;
    };
  }, [support, owner, permission]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  // Straight from the tap: subscribePush's first await is the permission prompt, which iOS shows only inside a user
  // gesture — so nothing is awaited before it here.
  async function toggle() {
    if (!owner || switching.current || enabled === null) return;
    switching.current = true;
    setToggling(true);
    const turnOn = !enabled;
    setEnabled(turnOn);
    try {
      if (turnOn) {
        const outcome = await subscribePush({ owner, locale });
        setEnabled(outcome === "subscribed");
        if (outcome === "subscribed") toast(t("push.toastOn"), "success");
        else if (outcome === "denied") {
          toast(t("push.toastDenied"), "error");
          // The switch gave way to the "blocked" explanation: focus stays in the card.
          statusRef.current?.focus();
        }
      } else {
        await unsubscribePush();
        setEnabled(false);
        toast(t("push.toastOff"), "success");
      }
    } catch (e) {
      // The helpers leave nothing half done (a failed POST undoes the browser subscription, a failed DELETE keeps
      // push on); an API code (PUSH_NOT_CONFIGURED, PUSH_SUBSCRIPTION_INVALID, …) reads from ApiErrors.
      setEnabled(!turnOn);
      toast(apiErr(e, t("prefError")), "error");
    } finally {
      switching.current = false;
      setToggling(false);
    }
  }

  async function sendTest() {
    if (testing.current || cooldown > 0) return;
    testing.current = true;
    setSending(true);
    try {
      const res = await api.post<PushTestResult>("/api/notifications/test");
      toast(t("push.toastTestSent", { sent: res.sent, failed: res.failed }), testResultTone(res));
    } catch (e) {
      toast(apiErr(e, t("push.testError")), testFailureTone(e instanceof ApiError ? e.status : undefined));
    } finally {
      testing.current = false;
      setSending(false);
      // Counted from the answer, after the server stamped the request, so the next tap lands outside its window.
      setCooldown(PUSH_TEST_COOLDOWN_SECONDS);
    }
  }

  const state = pushCardState({ support, permission, enabled });
  if (state === "hidden") return null;

  // Checked only when on; while the browser is asking, a pending position (the status line says what it waits for).
  const look = pushSwitchLook(state);
  const on = look === "on";
  const pending = look === "pending";
  const testWaiting = sending || cooldown > 0;
  const status =
    state === "on" ? t("push.statusOn")
    : state === "off" ? t("push.statusOff")
    : state === "ask" ? t("push.statusAsk")
    : state === "asking" ? t("push.statusAsking")
    : state === "denied" ? t("push.statusDenied")
    : state === "ios-install" ? t("push.statusIosInstall")
    : t("push.statusUnsupported");

  return (
    <Card className="reveal flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p id="push-title" className="text-sm font-bold text-ink">
            {t("push.title")}
          </p>
          {state === "checking" ? (
            <Skeleton className="mt-1.5 w-40 max-w-full" />
          ) : (
            <p
              id="push-status"
              ref={statusRef}
              tabIndex={-1}
              className="mt-0.5 text-pretty text-xs text-faint focus:outline-none"
            >
              {status}
            </p>
          )}
          {state === "ios-install" && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-describedby="push-status"
              onClick={onIosHowTo}
              className="inline-flex min-h-11 items-center rounded-sm text-xs font-bold text-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink md:mt-1 md:min-h-0"
            >
              {t("push.iosHowTo")}
            </button>
          )}
        </div>
        {state === "checking" && <Skeleton className="w-11" />}
        {pushSwitchShown(state) && (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="push-title"
            aria-describedby="push-status"
            onClick={() => void toggle()}
            // 44px target below md around the 24px track; compact from md (same switch as the type preferences).
            className="inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink md:h-8 md:w-12"
          >
            <span
              aria-hidden
              className={cn(
                "relative h-6 w-11 rounded-full border transition-colors",
                on ? "border-ink bg-ink" : pending ? "border-ink bg-panel" : "border-rule bg-panel"
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 h-[1.125rem] w-[1.125rem] rounded-full border motion-safe:transition-transform",
                  on ? "translate-x-5 border-paper bg-paper" : pending ? "translate-x-2.5 border-ink bg-card" : "border-rule bg-card"
                )}
              />
            </span>
          </button>
        )}
      </div>

      {pushTestShown(state) && (
        <div className="flex flex-col gap-2 border-t border-dotted border-rule pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p id="push-test-hint" className="text-pretty text-xs text-faint">
            {cooldown > 0 ? t("push.testWait", { seconds: cooldown }) : t("push.testHint")}
          </p>
          {/* aria-disabled while sending / waiting, not disabled: the button keeps focus after the tap. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={!pushTestEnabled(state, toggling)}
            aria-disabled={testWaiting || undefined}
            aria-describedby="push-test-hint"
            onClick={() => void sendTest()}
            className="shrink-0 aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            {sending && <Spinner className="mr-2 motion-reduce:animate-none" />}
            {t("push.test")}
          </Button>
        </div>
      )}
    </Card>
  );
}
