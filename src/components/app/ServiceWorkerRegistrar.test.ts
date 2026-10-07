import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The registrar's two parts are client components that only run effects (no DOM environment here): their contract is
// pinned on the source. The logic they call (support, registration URL, owner marker, sync rules, message filter) is
// behavior-tested in src/lib/push/client.test.ts.
const read = (path: string) => (existsSync(join(process.cwd(), path)) ? readFileSync(join(process.cwd(), path), "utf8") : "");
const registrar = read("src/components/app/ServiceWorkerRegistrar.tsx");
const layout = read("src/app/(app)/layout.tsx");
const pushSync = registrar.slice(registrar.indexOf("export function PushSync()"), registrar.indexOf("export function PushMessageListener()"));
const listener = registrar.slice(registrar.indexOf("export function PushMessageListener()"));

// Cycle D review minor 1 / cycle G review M5: the sync needs only the session and the locale, so it is split from the
// message listener (which needs the notifications provider, i.e. a house) and runs before the onboarding gate — a
// member without a house yet re-registers, or releases a shared browser's subscription, too.
describe("ServiceWorkerRegistrar — PushSync + PushMessageListener (spec 010 — criteria 1, 2, 8)", () => {
  it("is a client module with two parts, each rendering nothing (the single registrar is gone)", () => {
    expect(registrar).toContain('"use client"');
    expect(pushSync).toContain("export function PushSync()");
    expect(listener).toContain("export function PushMessageListener()");
    expect(pushSync).toContain("return null;");
    expect(listener).toContain("return null;");
    expect(registrar).not.toContain("export function ServiceWorkerRegistrar");
  });

  it("each does nothing unless push is configured and supported (no worker registered otherwise)", () => {
    expect(pushSync.match(/pushSupport\(\) !== "ok"/g)).toHaveLength(1);
    expect(listener.match(/pushSupport\(\) !== "ok"/g)).toHaveLength(1);
  });

  it("PushSync needs only the session and the locale — no notifications provider, so it can run without a house", () => {
    expect(pushSync).toContain("const { me } = useSession();");
    expect(pushSync).toContain("const locale = useLocale();");
    expect(pushSync).toContain("const owner = me?.user.publicId ?? null;");
    expect(pushSync).not.toContain("useNotifications");
  });

  it("PushSync syncs on load for the signed-in member, with the app locale, and again when either changes", () => {
    expect(pushSync).toMatch(/if \(!owner \|\| pushSupport\(\) !== "ok"\) return;/);
    expect(pushSync).toContain("syncPush({ owner, locale }).catch(() => {});");
    expect(pushSync).toContain("}, [owner, locale]);");
  });

  it("PushSync syncs once per owner + locale per mount: StrictMode's double effect (and re-renders) never sync twice", () => {
    expect(pushSync).toContain("const synced = useRef<string | null>(null);");
    expect(pushSync).toMatch(
      /const key = `\$\{owner\}\|\$\{locale\}`;\s*if \(synced\.current === key\) return;\s*synced\.current = key;[\s\S]*?syncPush\(\{ owner, locale \}\)/
    );
    // A ref (per mount), not module state: signing in again remounts the (app) tree and must sync again — the logout
    // deleted every row, and that sync is what brings this device back (criterion 9).
    expect(registrar).not.toMatch(/^let /m);
  });

  // Cycle E (ruling on cycle D concern 5): the provider's noticeReceived refreshes the bell AND bumps returnCount, so an
  // open Notices list reloads too (pinned in notifications-ui.test.ts).
  it("PushMessageListener hands the worker's push messages to the provider (bell + open Notices list), and stops on unmount", () => {
    expect(listener).toContain("const { noticeReceived } = useNotifications();");
    expect(listener).toMatch(/return listenForPushMessages\(noticeReceived\);\s*\}, \[noticeReceived\]\);/);
    expect(listener).not.toContain("refreshUnread");
    expect(listener).not.toContain("syncPush");
  });

  it("never prompts for permission and never subscribes by itself (only the member's tap does, criterion 3)", () => {
    expect(registrar).not.toContain("requestPermission");
    expect(registrar).not.toContain("subscribePush");
    expect(registrar).not.toContain("navigator.serviceWorker.register");
  });

  it("imports no server-only module", () => {
    for (const forbidden of ["@/services", "@/lib/push/endpoint", "@/lib/push/payload", "@/lib/push/schedule", "@/lib/push/config", "web-push", "next/headers", "@/i18n/request"]) {
      expect(registrar).not.toContain(forbidden);
    }
  });

  it("app layout: PushSync once, before the onboarding gate and outside the provider; the listener once, inside it next to the chrome", () => {
    expect(layout).toContain('import { PushMessageListener, PushSync } from "@/components/app/ServiceWorkerRegistrar";');
    expect(layout.match(/<PushSync \/>/g)).toHaveLength(1);
    expect(layout.match(/<PushMessageListener \/>/g)).toHaveLength(1);
    const order = ["if (!me) return null;", "<PushSync />", "me.user.groups.length === 0 ?", "<Onboarding />", "<NotificationsProvider>"].map((s) => layout.indexOf(s));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Onboarding is a branch, not an early return that would skip the sync; PushSync stays the same first child in both
    // branches, so creating or joining a house keeps it mounted (no second sync).
    expect(layout).not.toMatch(/return\s*<Onboarding/);
    expect(layout).toMatch(/<NotificationsProvider>\s*<PushMessageListener \/>\s*<AppChrome>\{children\}<\/AppChrome>\s*<\/NotificationsProvider>/);
  });
});

// Cycle G review M3: a password change bumps sessionVersion and the server deletes every push subscription of the
// account in the same transaction (criterion 9). The route re-signs this device's cookie, so nothing reloads — without
// a sync here, push stayed silently off on the very device that changed the password until the next load.
describe("password change re-registers this device (spec 010 — criterion 9; cycle G review M3)", () => {
  // The page is stored with CRLF line endings: normalized, so the section ends at its own closing brace.
  const account = read("src/app/(app)/account/page.tsx").replace(/\r\n/g, "\n");
  const section = account.slice(account.indexOf("function PasswordSection"), account.indexOf("\n}\n", account.indexOf("function PasswordSection")));
  const onSave = section.slice(section.indexOf("async function onSave"), section.indexOf("} catch (err) {", section.indexOf("async function onSave")));

  it("imports the sync helper and the app locale; the page hands the member's publicId to the section", () => {
    expect(section).toContain("function PasswordSection({ hasPassword, owner }");
    expect(section).not.toContain("function DeleteAccountSection");
    expect(account).toContain('import { syncPush } from "@/lib/push/client";');
    expect(account).toMatch(/import \{ useLocale, useTranslations \} from "next-intl";/);
    expect(account).toContain("<PasswordSection hasPassword={me.user.hasPassword} owner={me.user.publicId} />");
    expect(section).toContain("const locale = useLocale();");
  });

  it("after the change succeeded (the new cookie is set), syncs without a prompt — best effort, never awaited", () => {
    const changed = onSave.indexOf('await api.post("/api/auth/password"');
    const sync = onSave.indexOf("syncPush({ owner, locale }).catch(() => {});");
    expect(changed).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(changed);
    expect(onSave).not.toContain("await syncPush");
    // Both branches (change and first definition) bump the version, so the sync is not inside either.
    expect(sync).toBeLessThan(onSave.indexOf("if (hasPassword) {"));
  });

  it("never prompts and never subscribes from here (permission was granted before; only the Preferences tap asks)", () => {
    expect(account).not.toContain("subscribePush");
    expect(account).not.toContain("requestPermission");
  });
});
