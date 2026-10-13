import { describe, expect, it } from "vitest";
import { parse as legacyParse } from "node:url";
import { isAllowedPushEndpoint, parsePushSubscription } from "@/lib/push/endpoint";

// Spec 010 criterion 4 (and the SSRF note in design.md › Security): the server POSTs every push to the
// subscription's endpoint, so only https URLs on the browsers' push services get through.

const b64url = (bytes: number, fill: number) => Buffer.alloc(bytes, fill).toString("base64url");
// 0xfb / 0xff bytes encode to "-" and "_": the fixtures exercise the URL-safe alphabet itself.
const P256DH = b64url(65, 0xfb);
const AUTH = b64url(16, 0xff);
const FCM = "https://fcm.googleapis.com/fcm/send/eXaMpLe-token:APA91bH_k3y-123";

const body = (overrides: Record<string, unknown> = {}) => ({
  endpoint: FCM,
  keys: { p256dh: P256DH, auth: AUTH },
  locale: "pt",
  ...overrides,
});

describe("isAllowedPushEndpoint (spec 010, criterion 4)", () => {
  it.each([
    ["Chrome / Android (FCM)", FCM],
    ["Firefox (Mozilla autopush)", "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl-example_token"],
    ["Safari (Apple)", "https://web.push.apple.com/QGuQyavXutnMH-example_token"],
    ["Edge (WNS)", "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bexample%3d"],
    ["the bare Mozilla host", "https://push.services.mozilla.com/wpush/v1/x"],
    ["the bare Apple host", "https://push.apple.com/x"],
    ["the bare WNS host", "https://notify.windows.com/w/?token=x"],
    ["a subdomain of FCM", "https://eu.fcm.googleapis.com/fcm/send/x"],
  ])("accepts %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it("accepts 1024 characters and rejects 1025", () => {
    const prefix = "https://fcm.googleapis.com/fcm/send/";
    expect(isAllowedPushEndpoint(prefix + "a".repeat(1024 - prefix.length))).toBe(true);
    expect(isAllowedPushEndpoint(prefix + "a".repeat(1025 - prefix.length))).toBe(false);
  });

  it.each([
    ["plain http", "http://fcm.googleapis.com/fcm/send/x"],
    ["wss", "wss://fcm.googleapis.com/fcm/send/x"],
    ["ftp", "ftp://fcm.googleapis.com/x"],
    ["file", "file:///etc/passwd"],
    ["javascript", "javascript:alert(1)//fcm.googleapis.com"],
    ["data", "data:text/plain,fcm.googleapis.com"],
  ])("rejects a non-https scheme: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["allowed host + attacker suffix", "https://fcm.googleapis.com.evil.com/fcm/send/x"],
    ["allowed host + attacker suffix (.test)", "https://fcm.googleapis.com.evil.test/fcm/send/x"],
    ["allowed host as a bare suffix", "https://evilfcm.googleapis.com/fcm/send/x"],
    ["the parent domain", "https://googleapis.com/fcm/send/x"],
    ["a sibling Google host", "https://android.googleapis.com/gcm/send/x"],
    ["a dash instead of a dot", "https://fcm-googleapis.com/fcm/send/x"],
    ["another TLD", "https://fcm.googleapis.co/fcm/send/x"],
    ["Apple host + attacker suffix", "https://web.push.apple.com.attacker.net/x"],
    ["Apple host as a bare suffix", "https://evilpush.apple.com/x"],
    ["Apple's parent domain", "https://apple.com/x"],
    ["Mozilla host as a bare suffix", "https://evilpush.services.mozilla.com/x"],
    ["Mozilla's parent domain", "https://services.mozilla.com/x"],
    ["WNS host as a bare suffix", "https://xnotify.windows.com/w/?token=x"],
    ["WNS's parent domain", "https://windows.com/x"],
    ["a trailing-dot host", "https://fcm.googleapis.com./fcm/send/x"],
    ["a Cyrillic homograph (punycode host)", "https://fсm.googleapis.com/fcm/send/x"],
    ["localhost", "https://localhost/x"],
    ["an arbitrary site", "https://example.com/fcm.googleapis.com"],
  ])("rejects a host outside the allow-list: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["IPv4 loopback", "https://127.0.0.1/x"],
    ["cloud metadata address", "https://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "https://[::1]/x"],
    ["hex IPv4 shorthand", "https://0x7f.1/x"],
    ["decimal IPv4", "https://2130706433/x"],
  ])("rejects an IP literal: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["allowed host as the username (real host is evil.com)", "https://fcm.googleapis.com@evil.com/x"],
    ["username in front of the allowed host", "https://evil.com@fcm.googleapis.com/x"],
    ["username and password", "https://user:pass@fcm.googleapis.com/x"],
    ["password only", "https://:pass@fcm.googleapis.com/x"],
  ])("rejects credentials in the URL: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["a custom port", "https://fcm.googleapis.com:8443/fcm/send/x"],
    ["port 80", "https://fcm.googleapis.com:80/fcm/send/x"],
    ["an explicit default port (not the canonical form)", "https://fcm.googleapis.com:443/fcm/send/x"],
  ])("rejects a port: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  // web-push sends with Node's legacy url.parse; the WHATWG parser here silently repairs these inputs into an
  // allowed host, which the legacy parser may read differently. Browsers always hand out the canonical form.
  it.each([
    ["a percent-encoded dot in the host (url.parse reads host 'fcm')", "https://fcm%2egoogleapis.com/fcm/send/x"],
    ["a backslash before the at-sign", "https://evil.com\\@fcm.googleapis.com/x"],
    ["a backslash as the authority slashes", "https:\\\\fcm.googleapis.com/x"],
    ["upper case", "HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/x"],
    ["a fullwidth letter in the host", "https://ｆcm.googleapis.com/fcm/send/x"],
    ["a tab inside the host", "https://fcm.google\tapis.com/fcm/send/x"],
    ["a NUL inside the host", "https://fcm.googleapis.com%00.evil.com/x"],
    ["leading whitespace", " https://fcm.googleapis.com/fcm/send/x"],
    ["a trailing newline", "https://fcm.googleapis.com/fcm/send/x\n"],
    ["a space in the path", "https://fcm.googleapis.com/fcm/send/a b"],
    ["missing authority slashes", "https:fcm.googleapis.com/fcm/send/x"],
    ["a single authority slash", "https:/fcm.googleapis.com/fcm/send/x"],
  ])("rejects a non-canonical URL: %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { href: FCM }],
    ["an array", [FCM]],
    ["an empty string", ""],
    ["text that is not a URL", "not a url"],
    ["a relative path", "/fcm/send/x"],
  ])("rejects %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  // SSRF found in review: WHATWG keeps these characters inside the host (and the href stays canonical), but
  // Node's legacy url.parse — the parser web-push sends with — ends the host at them.
  it.each([
    ["a semicolon before an allowed suffix (loopback)", "https://127.0.0.1;.push.apple.com/x"],
    ["a semicolon before an allowed suffix (metadata IP)", "https://169.254.169.254;.fcm.googleapis.com/x"],
    ["a quote before an allowed suffix", "https://evil.example'.fcm.googleapis.com/x"],
    ["a backtick before an allowed suffix", "https://evil.example`.notify.windows.com/x"],
    ["a brace before an allowed suffix", "https://evil.example{.push.apple.com/x"],
    ["an empty leading label", "https://.fcm.googleapis.com/"],
    ["an empty inner label", "https://a..fcm.googleapis.com/"],
  ])("rejects %s", (_label, endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  // The invariant behind the allow-list: whatever we accept, the parser web-push uses reads the same host,
  // with no port and no credentials. Every ASCII character placed before an allowed suffix, plus the fixtures.
  it("anything accepted is read identically by Node's legacy url.parse (no host, port or auth disagreement)", () => {
    const candidates = [
      ...Array.from({ length: 128 }, (_, code) => `https://a${String.fromCharCode(code)}b.fcm.googleapis.com/x`),
      ...Array.from({ length: 128 }, (_, code) => `https://a${String.fromCharCode(code)}.push.apple.com/x`),
      FCM,
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl-example_token",
      "https://web.push.apple.com/QGuQyavXutnMH-example_token",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2bexample%3d",
    ];
    for (const candidate of candidates.filter((c) => isAllowedPushEndpoint(c))) {
      const legacy = legacyParse(candidate);
      expect({ candidate, host: legacy.hostname, port: legacy.port, auth: legacy.auth }).toEqual({
        candidate,
        host: new URL(candidate).hostname,
        port: null,
        auth: null,
      });
    }
  });
});

describe("parsePushSubscription (spec 010, criterion 4)", () => {
  it("returns exactly the stored fields for a valid subscription", () => {
    expect(parsePushSubscription(body())).toEqual({ endpoint: FCM, p256dh: P256DH, auth: AUTH, locale: "pt" });
  });

  it("drops every other field (PushSubscription.toJSON's expirationTime, or an injected owner)", () => {
    const parsed = parsePushSubscription(body({ expirationTime: null, userId: 99, groupId: 7, id: 1 }));
    expect(parsed).toEqual({ endpoint: FCM, p256dh: P256DH, auth: AUTH, locale: "pt" });
  });

  it.each(["en", "pt", "es", "fr"])("accepts the app locale %s", (locale) => {
    expect(parsePushSubscription(body({ locale }))?.locale).toBe(locale);
  });

  it.each([
    ["an unsupported language", "de"],
    ["upper case", "EN"],
    ["a region tag", "pt-BR"],
    ["an empty string", ""],
    ["a number", 1],
    ["null", null],
  ])("rejects a locale outside en/pt/es/fr: %s", (_label, locale) => {
    expect(parsePushSubscription(body({ locale }))).toBeNull();
  });

  // The service worker's pushsubscriptionchange re-registration cannot know the app locale: an absent locale is
  // allowed (a new row gets the schema default, an existing row keeps its own); a present one must be valid.
  it("accepts a missing locale and leaves it out", () => {
    expect(parsePushSubscription({ endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } })).toEqual({
      endpoint: FCM,
      p256dh: P256DH,
      auth: AUTH,
    });
  });

  it("checks the key length before decoding (an oversized key is rejected outright)", () => {
    expect(parsePushSubscription(body({ keys: { p256dh: P256DH + "A".repeat(10_000), auth: AUTH } }))).toBeNull();
  });

  it("rejects an endpoint outside the allow-list (the same check as isAllowedPushEndpoint)", () => {
    expect(parsePushSubscription(body({ endpoint: "https://fcm.googleapis.com.evil.com/fcm/send/x" }))).toBeNull();
    expect(parsePushSubscription(body({ endpoint: "http://fcm.googleapis.com/fcm/send/x" }))).toBeNull();
    expect(parsePushSubscription(body({ endpoint: undefined }))).toBeNull();
  });

  it.each([
    ["64 bytes", b64url(64, 0xfb)],
    ["66 bytes", b64url(66, 0xfb)],
    ["standard base64 ('+' and '/')", Buffer.alloc(65, 0xfb).toString("base64")],
    ["padded with '='", `${b64url(65, 0xfb)}=`],
    ["surrounded by whitespace", ` ${P256DH} `],
    ["the auth secret instead", AUTH],
    ["an empty string", ""],
    ["a number", 65],
    ["missing", undefined],
  ])("rejects a p256dh key that is not base64url of 65 bytes: %s", (_label, p256dh) => {
    expect(parsePushSubscription(body({ keys: { p256dh, auth: AUTH } }))).toBeNull();
  });

  it.each([
    ["15 bytes", b64url(15, 0xff)],
    ["17 bytes", b64url(17, 0xff)],
    ["standard base64 padding", Buffer.alloc(16, 0xff).toString("base64")],
    ["a non-alphabet character", `${AUTH.slice(0, -1)}.`],
    ["the p256dh key instead", P256DH],
    ["an empty string", ""],
    ["an object", { value: AUTH }],
    ["missing", undefined],
  ])("rejects an auth secret that is not base64url of 16 bytes: %s", (_label, auth) => {
    expect(parsePushSubscription(body({ keys: { p256dh: P256DH, auth } }))).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["a string", `${P256DH}.${AUTH}`],
    ["an array", [P256DH, AUTH]],
  ])("rejects keys that are %s", (_label, keys) => {
    expect(parsePushSubscription(body({ keys }))).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", JSON.stringify(body())],
    ["an array", [body()]],
    ["a number", 1],
  ])("rejects a body that is %s", (_label, input) => {
    expect(parsePushSubscription(input)).toBeNull();
  });
});
