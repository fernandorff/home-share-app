import { describe, expect, it } from "vitest";
import {
  PUSH_TEST_COOLDOWN_SECONDS,
  pushCardState,
  pushSwitchLook,
  pushSwitchShown,
  pushTestEnabled,
  pushTestShown,
  testFailureTone,
  testResultTone,
  type PushCardEnv,
  type PushCardState,
} from "@/lib/push-view";
import type { PushSupport } from "@/lib/push/client";

// The "Receive on this device" card (spec 010, task 16; criteria 1, 3, 10, 11; design › UI). The card reads the
// browser through src/lib/push/client.ts; what it shows from those readings is decided here.

const PERMISSIONS: NotificationPermission[] = ["default", "granted", "denied"];
const ENABLED: (boolean | null)[] = [null, false, true];

describe("pushCardState", () => {
  it.each(PERMISSIONS.flatMap((permission) => ENABLED.map((enabled) => [permission, enabled] as const)))(
    "unconfigured → hidden, whatever the browser holds (permission %s, enabled %s; criterion 1)",
    (permission, enabled) => {
      expect(pushCardState({ support: "unconfigured", permission, enabled })).toBe("hidden");
    }
  );

  it.each([
    ["unsupported", "unsupported"],
    ["ios-needs-install", "ios-install"],
  ] as const)("%s → %s: the reason instead of the switch, never a prompt (criterion 11)", (support, expected) => {
    for (const permission of PERMISSIONS) for (const enabled of ENABLED) {
      expect(pushCardState({ support, permission, enabled })).toBe(expected);
    }
  });

  it.each(ENABLED)("a blocked permission wins over the device's subscription (enabled %s; criterion 11)", (enabled) => {
    expect(pushCardState({ support: "ok", permission: "denied", enabled })).toBe("denied");
  });

  it.each(["default", "granted"] as const)("not read yet → checking (permission %s)", (permission) => {
    expect(pushCardState({ support: "ok", permission, enabled: null })).toBe("checking");
  });

  it("on: this member's subscription is here (permission granted)", () => {
    expect(pushCardState({ support: "ok", permission: "granted", enabled: true })).toBe("on");
  });

  // Cycle E concern / cycle G review M2: the switch's optimistic value while the browser's prompt (or Chrome's quiet
  // chip) is still open must not read as "on" — the permission is still "default" and nothing is subscribed yet.
  it("asking: just turned on, the browser has not answered yet (permission still default) — not on", () => {
    expect(pushCardState({ support: "ok", permission: "default", enabled: true })).toBe("asking");
  });

  it("off: permission granted, nothing for this member here", () => {
    expect(pushCardState({ support: "ok", permission: "granted", enabled: false })).toBe("off");
  });

  it("ask: off, and the browser will ask on the first tap", () => {
    expect(pushCardState({ support: "ok", permission: "default", enabled: false })).toBe("ask");
  });

  it("every combination maps to exactly one known state", () => {
    const supports: PushSupport[] = ["unconfigured", "unsupported", "ios-needs-install", "ok"];
    const known: PushCardState[] = ["hidden", "unsupported", "ios-install", "denied", "checking", "ask", "asking", "off", "on"];
    const seen = new Set<PushCardState>();
    for (const support of supports) for (const permission of PERMISSIONS) for (const enabled of ENABLED) {
      const env: PushCardEnv = { support, permission, enabled };
      const state = pushCardState(env);
      expect(known).toContain(state);
      seen.add(state);
    }
    expect([...seen].sort()).toEqual([...known].sort());
  });
});

describe("what the card offers per state", () => {
  const ALL: PushCardState[] = ["hidden", "unsupported", "ios-install", "denied", "checking", "ask", "asking", "off", "on"];

  it("the switch only where it can work: on, off, ask, asking (criterion 3); the others explain instead (criterion 11)", () => {
    expect(ALL.filter(pushSwitchShown)).toEqual(["ask", "asking", "off", "on"]);
  });

  it("the switch reads on only when on; while the browser is asking it shows pending, never checked (M2)", () => {
    expect(Object.fromEntries(ALL.filter(pushSwitchShown).map((state) => [state, pushSwitchLook(state)]))).toEqual({
      ask: "off",
      asking: "pending",
      off: "off",
      on: "on",
    });
  });

  it("the test row sits under the switch (and its placeholder while checking)", () => {
    expect(ALL.filter(pushTestShown)).toEqual(["checking", "ask", "asking", "off", "on"]);
  });

  it("'Send test notice' is enabled only while subscribed (design › UI) — not while the browser is still asking (M2)", () => {
    expect(ALL.filter((state) => pushTestEnabled(state, false))).toEqual(["on"]);
  });

  it("'Send test notice' stays disabled while a toggle is in flight, even with the switch already on (M2)", () => {
    // Turning on with the permission already granted flips the switch to on before the subscription is stored.
    expect(ALL.filter((state) => pushTestEnabled(state, true))).toEqual([]);
  });
});

describe("test notice", () => {
  it("waits 10 s after each send: the server allows one test per 10 s and counts refused taps too", () => {
    expect(PUSH_TEST_COOLDOWN_SECONDS).toBe(10);
  });

  it.each([
    [{ sent: 1, failed: 0 }, "success"],
    [{ sent: 2, failed: 1 }, "success"],
    [{ sent: 0, failed: 1 }, "error"],
    [{ sent: 0, failed: 0 }, "error"],
  ] as const)("%o reads as %s (a test that reached no device failed)", (result, tone) => {
    expect(testResultTone(result)).toBe(tone);
  });

  it.each([
    [429, "info"],
    [409, "error"],
    [503, "error"],
    [500, "error"],
    [undefined, "error"],
  ] as const)("a failure with status %s reads as %s (429 = another test just went out: a wait, not a failure)", (status, tone) => {
    expect(testFailureTone(status)).toBe(tone);
  });
});
