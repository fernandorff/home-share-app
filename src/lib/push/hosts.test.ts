import { describe, it, expect } from "vitest";
import { isPushServiceHost, PUSH_SERVICE_HOSTS } from "./hosts";
import { isAllowedPushEndpoint } from "./endpoint";

describe("PUSH_SERVICE_HOSTS / isPushServiceHost (spec 010)", () => {
  it("lists the four browsers' push services", () => {
    expect([...PUSH_SERVICE_HOSTS]).toEqual(["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"]);
  });

  it("accepts each host itself and any subdomain of it, whatever the case", () => {
    for (const host of PUSH_SERVICE_HOSTS) {
      expect(isPushServiceHost(host)).toBe(true);
      expect(isPushServiceHost(`a-1.b.${host}`)).toBe(true);
    }
    expect(isPushServiceHost("updates.push.services.mozilla.com")).toBe(true);
    expect(isPushServiceHost("web.push.apple.com")).toBe(true);
    expect(isPushServiceHost("wns2-par02p.notify.windows.com")).toBe(true);
    expect(isPushServiceHost("FCM.GoogleAPIs.com")).toBe(true);
  });

  it("rejects a bare suffix, a look-alike, an empty label, a port and any character a real host never has", () => {
    for (const host of [
      "evilfcm.googleapis.com",
      "fcm.googleapis.com.evil.com",
      "googleapis.com",
      "apple.com",
      ".fcm.googleapis.com",
      "a..fcm.googleapis.com",
      "fcm.googleapis.com.",
      "fcm.googleapis.com:443",
      "127.0.0.1;.push.apple.com",
      "x y.push.apple.com",
      "",
    ]) {
      expect(isPushServiceHost(host), host).toBe(false);
    }
  });

  // endpoint.ts keeps its own copy of the list until both are unified (cycle G). They must agree: an endpoint stored on
  // a host the scrubber does not know would reach Sentry and the logs uncut (criterion 13).
  it("agrees with the endpoint validator's allow-list", () => {
    const candidates = [
      ...PUSH_SERVICE_HOSTS.flatMap((host) => [host, `sub.${host}`]),
      "android.googleapis.com",
      "updates.push.services.mozilla.com",
      "evilfcm.googleapis.com",
      "fcm.googleapis.com.evil.com",
      "push.example.com",
    ];
    for (const host of candidates) {
      expect(isPushServiceHost(host), host).toBe(isAllowedPushEndpoint(`https://${host}/x`));
    }
  });
});
