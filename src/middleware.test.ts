import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import * as nextStaticInfo from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { config, middleware } from "./middleware";
import { SESSION_COOKIE, signSession } from "@/lib/auth";
import { REQUEST_ID_HEADER, REQUEST_PATH_HEADER, REQUEST_START_HEADER } from "@/lib/observability/request-context";

const matches = (pathname: string) => new RegExp(`^${config.matcher[0]}$`).test(pathname);

const forwarded = (response: Response, header: string) => response.headers.get(`x-middleware-request-${header}`);

async function sessionCookie() {
  const token = await signSession({ userId: 1, publicId: "pub-1", name: "Test", sessionVersion: 0 });
  return `${SESSION_COOKIE}=${token}`;
}

describe("middleware matcher (spec 007)", () => {
  it("never runs on the Sentry tunnel or static assets", () => {
    expect(matches("/monitoring")).toBe(false);
    expect(matches("/_next/static/chunks/app.js")).toBe(false);
  });

  it("skips the auth gate for the tunnel path only, with or without a trailing slash", () => {
    expect(matches("/monitoring")).toBe(false);
    expect(matches("/monitoring/")).toBe(false);
  });

  it("keeps gating paths that merely start with or contain 'monitoring'", () => {
    expect(matches("/monitoring-x")).toBe(true);
    expect(matches("/monitoringx/secret")).toBe(true);
    expect(matches("/monitoring/x")).toBe(true);
    expect(matches("/api/monitoring")).toBe(true);
    expect(matches("/Monitoring")).toBe(true);
  });

  it("skips the auth gate for /api/health only, with or without a trailing slash", () => {
    expect(matches("/api/health")).toBe(false);
    expect(matches("/api/health/")).toBe(false);
  });

  it("keeps gating paths that merely start with or contain 'health'", () => {
    expect(matches("/api/healthx")).toBe(true);
    expect(matches("/api/health/x")).toBe(true);
    expect(matches("/api/healthcheck")).toBe(true);
  });

  it("still guards pages and APIs", () => {
    expect(matches("/expenses")).toBe(true);
    expect(matches("/api/expenses")).toBe(true);
  });
});

describe("middleware request context (R11)", () => {
  it("forwards fresh observability headers on pass-through, never the client's", async () => {
    const response = await middleware(new NextRequest("http://localhost/api/health", { headers: { [REQUEST_ID_HEADER]: "forged" } }));
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe("/api/health");
    const id = response.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`);
    expect(id).toBeTruthy();
    expect(id).not.toBe("forged");
  });

  it("replaces every spoofed header on the public page branch", async () => {
    const response = await middleware(
      new NextRequest("http://localhost/auth/login", {
        headers: { [REQUEST_ID_HEADER]: "forged", [REQUEST_PATH_HEADER]: "/admin", [REQUEST_START_HEADER]: "1" },
      })
    );
    expect(forwarded(response, REQUEST_ID_HEADER)).not.toBe("forged");
    expect(forwarded(response, REQUEST_PATH_HEADER)).toBe("/auth/login");
    expect(forwarded(response, REQUEST_START_HEADER)).not.toBe("1");
  });

  it("replaces every spoofed header on the authenticated branch", async () => {
    const response = await middleware(
      new NextRequest("http://localhost/api/expenses", {
        headers: {
          cookie: await sessionCookie(),
          [REQUEST_ID_HEADER]: "forged",
          [REQUEST_PATH_HEADER]: "/api/health",
          [REQUEST_START_HEADER]: "1",
        },
      })
    );
    expect(response.status).toBe(200);
    expect(forwarded(response, REQUEST_ID_HEADER)).not.toBe("forged");
    expect(forwarded(response, REQUEST_PATH_HEADER)).toBe("/api/expenses");
    expect(forwarded(response, REQUEST_START_HEADER)).not.toBe("1");
  });
});

describe("middleware cron bypass (spec 008 — criterion 19)", () => {
  it("still runs on /api/cron/* so the request context is stamped for logs and Sentry tags", () => {
    expect(matches("/api/cron/recurring-expenses")).toBe(true);
  });

  it("lets /api/cron/recurring-expenses through without a session cookie and without a redirect", async () => {
    const response = await middleware(new NextRequest("http://localhost/api/cron/recurring-expenses"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(forwarded(response, REQUEST_PATH_HEADER)).toBe("/api/cron/recurring-expenses");
    expect(forwarded(response, REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("lets /api/cron/notifications (spec 009) through without a session cookie and without a redirect", async () => {
    expect(matches("/api/cron/notifications")).toBe(true);
    const response = await middleware(new NextRequest("http://localhost/api/cron/notifications"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(forwarded(response, REQUEST_PATH_HEADER)).toBe("/api/cron/notifications");
  });

  it("overwrites a forged request id on the cron path too", async () => {
    const response = await middleware(
      new NextRequest("http://localhost/api/cron/recurring-expenses", { headers: { [REQUEST_ID_HEADER]: "forged" } })
    );
    expect(response.status).toBe(200);
    expect(forwarded(response, REQUEST_ID_HEADER)).toBeTruthy();
    expect(forwarded(response, REQUEST_ID_HEADER)).not.toBe("forged");
  });

  it("keeps gating paths that merely start with 'cron'", async () => {
    for (const pathname of ["/api/cronx", "/api/cron-admin/jobs", "/api/crons"]) {
      const response = await middleware(new NextRequest(`http://localhost${pathname}`));
      expect(response.status).toBe(401);
    }
  });

  it("does not open any page under /cron", async () => {
    const response = await middleware(new NextRequest("http://localhost/cron/recurring-expenses"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/login");
  });
});

describe("middleware PWA files (spec 009 — criterion 1)", () => {
  // Browsers fetch the manifest and its icons without the session cookie: the matcher must skip them, or a
  // cookie-less fetch would be redirected to the login page.
  it.each(["/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"])(
    "never runs on %s, so it is served without a cookie",
    (pathname) => {
      expect(matches(pathname)).toBe(false);
    }
  );

  it("never runs on the favicon (app/icon.svg) either: a logged-out tab shows the app icon", () => {
    expect(matches("/icon.svg")).toBe(false);
  });

  it("anchored: look-alike paths stay gated", () => {
    expect(matches("/iconsx")).toBe(true);
    expect(matches("/icons")).toBe(true);
    expect(matches("/manifestXjson")).toBe(true);
    expect(matches("/manifest.json/secret")).toBe(true);
    expect(matches("/icon.svg/secret")).toBe(true);
  });

  // spec 010 — criterion 2: the browser fetches the service worker (and its update checks) without a cookie.
  it("never runs on /sw.js, so the service worker is served without a session", () => {
    expect(matches("/sw.js")).toBe(false);
  });

  it.each(["/sw.jsx", "/sw.js/secret", "/swXjs", "/sw.json", "/api/sw.js"])(
    "anchored: only /sw.js itself skips the gate, %s stays gated",
    (pathname) => {
      expect(matches(pathname)).toBe(true);
    }
  );

  it("favicon.ico / favicon.svg are anchored too, and no workbox prefix skips the gate any more", () => {
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/favicon.svg")).toBe(false);
    expect(matches("/favicon.icox")).toBe(true);
    expect(matches("/favicon.ico/secret")).toBe(true);
    expect(matches("/faviconXico")).toBe(true);
    expect(matches("/workbox-abc")).toBe(true);
  });

  // spec 010 cycle D: the registrar registers /sw.js?k=<VAPID public key>. Compiled and run with Next's own matcher
  // code: the regexp runs on the pathname only, the query is consulted for has/missing conditions (none here).
  it("the registered worker URL /sw.js?k=<key> skips the gate too: Next matches the path, never the query", () => {
    const { getMiddlewareMatchers } = nextStaticInfo as unknown as {
      getMiddlewareMatchers: (matcher: string[], nextConfig: object) => Parameters<typeof getMiddlewareRouteMatcher>[0];
    };
    const runs = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {}));
    const at = (href: string) => {
      const url = new URL(href, "http://localhost");
      return runs(url.pathname, { headers: {}, cookies: {} } as never, Object.fromEntries(url.searchParams));
    };

    expect(at("/sw.js")).toBe(false);
    expect(at("/sw.js?k=BGNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5_gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp-goaI")).toBe(false);
    expect(at("/sw.js?k=")).toBe(false);
    // The query never opens anything either.
    expect(at("/sw.jsx?k=abc")).toBe(true);
    expect(at("/expenses?k=/sw.js")).toBe(true);
    expect(at("/api/push-subscriptions?sw.js")).toBe(true);
  });

  it("a cookie-less look-alike of /sw.js is still sent to the login page", async () => {
    const response = await middleware(new NextRequest("http://localhost/sw.jsx"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/login");
  });

  it("still gates the manifest's start_url", async () => {
    expect(matches("/expenses")).toBe(true);
    const response = await middleware(new NextRequest("http://localhost/expenses"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/login");
  });
});

describe("middleware session gate (unchanged by spec 007)", () => {
  it("still redirects an unauthenticated page request to the login page", async () => {
    const response = await middleware(new NextRequest("http://localhost/expenses"));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/login");
    expect(forwarded(response, REQUEST_ID_HEADER)).toBeNull();
  });

  it("still answers 401 JSON to an unauthenticated protected API request", async () => {
    const response = await middleware(new NextRequest("http://localhost/api/expenses"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
    expect(forwarded(response, REQUEST_ID_HEADER)).toBeNull();
  });

  it("does not let a forged request id open a protected page", async () => {
    const response = await middleware(new NextRequest("http://localhost/expenses", { headers: { [REQUEST_ID_HEADER]: "forged" } }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/login");
  });

  it("still redirects a signed-in user away from the auth pages", async () => {
    const response = await middleware(new NextRequest("http://localhost/auth/login", { headers: { cookie: await sessionCookie() } }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/expenses");
  });
});
