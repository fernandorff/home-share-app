import { describe, it, expect } from "vitest";
import { isPushServiceHost, PUSH_SERVICE_HOSTS } from "./hosts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  // The Rust server keeps its own copy for the endpoint validator. They must agree: an endpoint stored on a host the
  // browser scrubber does not know would reach Sentry uncut (criterion 13).
  it("agrees with the Rust server's allow-list", () => {
    const rust = readFileSync(join(process.cwd(), "server/src/routes/push.rs"), "utf8");
    const list = rust.match(/pub const PUSH_SERVICE_HOSTS: \[&str; \d+\] = \[([^\]]*)\]/);
    expect(list).not.toBeNull();
    expect(list![1].match(/"[^"]+"/g)!.map((host) => JSON.parse(host))).toEqual([...PUSH_SERVICE_HOSTS]);
  });
});
