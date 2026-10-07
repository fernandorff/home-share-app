// View rules of the "Receive on this device" card (spec 010, task 16; criteria 1, 3, 10, 11; design › UI). Pure — no
// React, no browser APIs — so what the card shows is unit-tested; the card reads the browser through
// src/lib/push/client.ts and hands those readings here.
import type { PushSupport } from "@/lib/push/client";

export type PushCardState = "hidden" | "unsupported" | "ios-install" | "denied" | "checking" | "ask" | "asking" | "off" | "on";

export interface PushCardEnv {
  support: PushSupport;
  permission: NotificationPermission;
  /** Push is on here for the signed-in member (pushEnabledHere, or the switch's optimistic value); null = not read yet. */
  enabled: boolean | null;
}

/**
 * What the card shows: nothing while push is unconfigured (criterion 1); why push cannot work here, instead of the
 * switch — a browser without push, Safari on iPhone/iPad outside the Home Screen app, a blocked permission
 * (criterion 11); otherwise the switch — on, off, off with the browser still to ask, or just turned on with the
 * browser asking right now (criterion 3).
 */
export function pushCardState({ support, permission, enabled }: PushCardEnv): PushCardState {
  if (support === "unconfigured") return "hidden";
  if (support === "unsupported") return "unsupported";
  if (support === "ios-needs-install") return "ios-install";
  // Blocked wins over whatever this device holds: the browser will neither ask nor show a notice.
  if (permission === "denied") return "denied";
  if (enabled === null) return "checking";
  // `enabled` with the permission still "default" = the switch was just turned on and the browser's prompt (or Chrome's
  // quiet chip) is still open: nothing is subscribed yet, so it must not read as on (cycle G review, M2).
  if (enabled) return permission === "granted" ? "on" : "asking";
  return permission === "granted" ? "off" : "ask";
}

/** The switch is offered only where it can work; the other states explain instead (criterion 11). */
export function pushSwitchShown(state: PushCardState): boolean {
  return state === "on" || state === "off" || state === "ask" || state === "asking";
}

/**
 * How the switch reads: checked only when on; while the browser is asking it shows a pending position (never
 * `aria-checked`), the status line saying what it waits for.
 */
export function pushSwitchLook(state: PushCardState): "on" | "pending" | "off" {
  return state === "on" ? "on" : state === "asking" ? "pending" : "off";
}

/** The test row sits under the switch (with the switch's placeholder while checking). */
export function pushTestShown(state: PushCardState): boolean {
  return state === "checking" || pushSwitchShown(state);
}

/**
 * "Send test notice" is enabled only while this device is subscribed (design › UI): never while the browser is still
 * asking, nor while a toggle is in flight — turning on with the permission already granted shows "on" before the
 * subscription is stored (cycle G review, M2).
 */
export function pushTestEnabled(state: PushCardState, toggling: boolean): boolean {
  return state === "on" && !toggling;
}

/**
 * Seconds "Send test notice" waits after each answer: the server allows one test per 10 s per member and its limiter
 * counts refused taps too, so tapping every 9 s would answer 429 forever (cycle C review, minor 4).
 */
export const PUSH_TEST_COOLDOWN_SECONDS = 10;

/** `POST /api/notifications/test` (criterion 10). */
export interface PushTestResult {
  sent: number;
  failed: number;
}

/** A test that reached no device reads as a failure. */
export function testResultTone({ sent }: PushTestResult): "success" | "error" {
  return sent > 0 ? "success" : "error";
}

/** A 429 means another test just went out (another tab or device): a wait, not a failure. */
export function testFailureTone(status: number | undefined): "info" | "error" {
  return status === 429 ? "info" : "error";
}
