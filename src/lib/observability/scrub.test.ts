import { describe, it, expect, vi } from "vitest";
import type { Event } from "@sentry/nextjs";
import type * as Hosts from "@/lib/push/hosts";
import { FILTERED, redactText, scrubEvent, scrubSpan, stripQuery } from "./scrub";
import { PUSH_SERVICE_HOSTS } from "@/lib/push/hosts";

const USER_ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
const HOUSE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

describe("redactText", () => {
  it("redacts e-mails, session/group cookie values, bearer tokens and JWTs", () => {
    expect(redactText("user ana.souza+x@example.com.br failed")).toBe("user [email] failed");
    expect(redactText("homeshare_session=abc.def; homeshare_group=7; locale=pt")).toBe(
      `homeshare_session=${FILTERED}; homeshare_group=${FILTERED}; locale=pt`
    );
    expect(redactText("Authorization: Bearer abc123")).toBe(`Authorization: Bearer ${FILTERED}`);
    expect(redactText("token eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.sig-part")).toBe("token [jwt]");
  });

  it("redacts the body snippet a JSON parse error echoes", () => {
    expect(redactText(`Unexpected token 'o', "not json a"... is not valid JSON`)).toBe(
      `Unexpected token 'o', "${FILTERED}" is not valid JSON`
    );
  });

  it("filters the VALUE of every [attr=...] pair in a DOM selector string (names live in aria-label/title/alt)", () => {
    expect(redactText('div > button[aria-label="Actions for Ana QA"]')).toBe('div > button[aria-label="[Filtered]"]');
    expect(redactText('span[aria-label="Ana Souza"][title="Ana Souza"]')).toBe('span[aria-label="[Filtered]"][title="[Filtered]"]');
    expect(redactText('img[alt="Júlia Caminho Feliz"]')).toBe('img[alt="[Filtered]"]');
    expect(redactText('input[type="text"][name="Percent of Ana"]')).toBe('input[type="[Filtered]"][name="[Filtered]"]');
  });

  it("filters the value of HTML-style title= / alt= / aria-label= attributes, double or single quoted", () => {
    expect(redactText('<span title="Júlia Caminho Feliz">x</span>')).toBe('<span title="[Filtered]">x</span>');
    expect(redactText("img alt='Ana Souza' src=a")).toBe('img alt="[Filtered]" src=a');
    expect(redactText('aria-label="Amount for Ana"')).toBe('aria-label="[Filtered]"');
  });

  it("filters a selector whose value was truncated before its closing quote, and quotes inside the value", () => {
    expect(redactText('div.card > button[aria-label="Actions for Ana Sou')).toBe('div.card > button[aria-label="[Filtered]"]');
    expect(redactText('b[aria-label="Ana "Nick" Souza"].x')).toBe('b[aria-label="[Filtered]"].x');
  });

  it("is idempotent on already-filtered selectors and keeps selectors without attribute values", () => {
    const once = redactText('span[aria-label="Ana"][title="Ana"]');
    expect(redactText(once)).toBe(once);
    expect(redactText('div#root > main.page > button.btn.btn-primary')).toBe('div#root > main.page > button.btn.btn-primary');
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("GET /api/expenses/:id 500")).toBe("GET /api/expenses/:id 500");
  });
});

describe("stripQuery", () => {
  it("drops the query string and the fragment", () => {
    expect(stripQuery("https://homeshare.app/auth/set-password?token=abc#top")).toBe("https://homeshare.app/auth/set-password");
    expect(stripQuery("/api/expenses")).toBe("/api/expenses");
  });
});

describe("scrubEvent", () => {
  it("removes cookies, body, env, query string and non-allowlisted headers from the request", () => {
    const event: Event = {
      request: {
        url: "https://homeshare.app/api/auth/login?token=abc",
        method: "POST",
        query_string: "token=abc",
        cookies: { homeshare_session: "eyJ.a.b" },
        data: '{"password":"hunter2"}',
        env: { REMOTE_ADDR: "1.2.3.4" },
        headers: {
          "user-agent": "UA",
          "content-type": "application/json",
          cookie: "homeshare_session=x",
          authorization: "Bearer x",
          "x-forwarded-for": "1.2.3.4",
        },
      },
    };
    expect(scrubEvent(event).request).toEqual({
      url: "https://homeshare.app/api/auth/login",
      method: "POST",
      headers: { "user-agent": "UA", "content-type": "application/json" },
    });
  });

  it("keeps only the opaque user id, and drops a user without one", () => {
    expect(scrubEvent({ user: { id: USER_ID, email: "ana@example.com", ip_address: "1.2.3.4", username: "ana" } }).user)
      .toEqual({ id: USER_ID });
    expect(scrubEvent({ user: { ip_address: "1.2.3.4" } }).user).toBeUndefined();
  });

  it("redacts free text and strips breadcrumb URL queries", () => {
    const event = scrubEvent({
      message: "login failed for ana@example.com",
      exception: { values: [{ type: "Error", value: "duplicate key ana@example.com" }] },
      breadcrumbs: [
        { category: "fetch", data: { method: "GET", url: "/api/expenses?search=ana@example.com", status_code: 500 } },
        { category: "navigation", data: { from: "/auth/set-password?token=abc", to: "/expenses?month=2026-06" } },
        { category: "log", message: "audit log failed for ana@example.com" },
      ],
    });
    expect(event.message).toBe("login failed for [email]");
    expect(event.exception?.values?.[0]?.value).toBe("duplicate key [email]");
    expect(event.breadcrumbs).toEqual([
      { category: "fetch", data: { method: "GET", url: "/api/expenses", status_code: 500 } },
      { category: "navigation", data: { from: "/auth/set-password", to: "/expenses" } },
      { category: "log", message: "audit log failed for [email]" },
    ]);
  });

  it("strips the query from every breadcrumb URL key and drops the split-out query/fragment keys", () => {
    const event = scrubEvent({
      breadcrumbs: [
        {
          category: "http",
          type: "http",
          data: {
            url: "https://oauth2.example.com/token?code=abc123",
            "url.query": "code=abc123",
            "url.fragment": "frag",
            "http.query": "?code=abc123",
            status_code: 200,
          },
        },
        {
          category: "navigation",
          data: { "url.full": "https://homeshare.app/auth/set-password?token=abc#x", "http.target": "/api/x?code=1" },
        },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "http", type: "http", data: { url: "https://oauth2.example.com/token", status_code: 200 } },
      { category: "navigation", data: { "url.full": "https://homeshare.app/auth/set-password", "http.target": "/api/x" } },
    ]);
    expect(JSON.stringify(event.breadcrumbs)).not.toMatch(/abc123|token=|code=/);
  });

  it("cuts Prisma client errors to their reason line (the invocation dump prints query arguments)", () => {
    const event = scrubEvent({
      exception: {
        values: [{
          type: "PrismaClientValidationError",
          value: '\nInvalid `prisma.expense.create()` invocation:\n\n{\n  data: {\n    description: "Rent for Ana",\n    amount: 1234.5\n  }\n}\n\nArgument `payerId` is missing.',
        }],
      },
    });
    expect(event.exception?.values?.[0]?.value).toBe("Argument `payerId` is missing.");
  });

  it("filters sensitive keys anywhere and keeps the dashboard tags", () => {
    const event = scrubEvent({
      extra: { password: "hunter2", nested: { joinCode: "AB12CD", access_token: "t", note: "ok" } },
      contexts: { auth: { Authorization: "Bearer x" } },
      tags: { route: "/api/expenses/:id", http_status: "500", api_error_code: "EXPENSE_NOT_FOUND", house: HOUSE_ID },
    });
    expect(event.extra).toEqual({ password: FILTERED, nested: { joinCode: FILTERED, access_token: FILTERED, note: "ok" } });
    expect(event.contexts).toEqual({ auth: { Authorization: FILTERED } });
    expect(event.tags).toEqual({ route: "/api/expenses/:id", http_status: "500", api_error_code: "EXPENSE_NOT_FOUND", house: HOUSE_ID });
  });

  it("never walks SDK-internal processing metadata", () => {
    const internal = { normalizedRequest: { headers: { cookie: "homeshare_session=x" } } };
    const event = scrubEvent({ message: "ana@example.com", sdkProcessingMetadata: internal });
    expect(event.message).toBe("[email]");
    expect(event.sdkProcessingMetadata).toBe(internal);
    expect(internal.normalizedRequest.headers.cookie).toBe("homeshare_session=x");
  });

  it("filters DOM-attribute values (people's names) from ui.* breadcrumbs, whatever else the crumb carries (C1)", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: "ui.click", message: 'div.flex > button[aria-label="Actions for Ana QA"]', data: { "ui.component_name": "Member" } },
        { category: "ui.input", message: 'span[aria-label="Ana Souza"][title="Ana Souza"]' },
        { category: "ui.click", message: 'button.btn > img[alt="Júlia Caminho Feliz"]' },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "ui.click", message: 'div.flex > button[aria-label="[Filtered]"]', data: { "ui.component_name": "Member" } },
      { category: "ui.input", message: 'span[aria-label="[Filtered]"][title="[Filtered]"]' },
      { category: "ui.click", message: 'button.btn > img[alt="[Filtered]"]' },
    ]);
    expect(JSON.stringify(event)).not.toMatch(/Ana|Júlia|Caminho/);
  });

  it("filters DOM-attribute values from the event message and exception values too", () => {
    const event = scrubEvent({
      message: 'click failed on button[aria-label="Actions for Ana QA"]',
      exception: { values: [{ type: "Error", value: 'Cannot read properties of null (reading x) at span[title="Júlia Caminho Feliz"]' }] },
    });
    expect(JSON.stringify(event)).not.toMatch(/Ana|Júlia|Caminho/);
  });

  it("strips the query from contexts.nextjs.request_path (the raw req.url of uncaught errors) (I2)", () => {
    const event = scrubEvent({
      contexts: {
        nextjs: { request_path: "/api/auth/google/callback?code=abc&state=s", router_kind: "App Router", request_type: "route" },
      },
    });
    expect(event.contexts?.nextjs).toEqual({ request_path: "/api/auth/google/callback", router_kind: "App Router", request_type: "route" });
    expect(JSON.stringify(event)).not.toMatch(/code=|state=|abc/);
    expect(scrubEvent({ contexts: { nextjs: { request_path: "/auth/set-password#frag" } } }).contexts?.nextjs?.request_path).toBe("/auth/set-password");
  });

  it("tolerates a nextjs context without a string request_path", () => {
    expect(scrubEvent({ contexts: { nextjs: { router_kind: "App Router" } } }).contexts).toEqual({ nextjs: { router_kind: "App Router" } });
    expect(scrubEvent({ contexts: { nextjs: { request_path: 5 } } }).contexts).toEqual({ nextjs: { request_path: 5 } });
  });

  it("drops console breadcrumbs (Prisma dumps, third-party logs) and keeps every other category (I3)", () => {
    const event = scrubEvent({
      breadcrumbs: [
        { category: "console", level: "error", message: "Invalid `prisma.expense.create()` invocation: { description: 'Rent for Ana', amount: 1234.5 }" },
        { category: "log", message: "Failed to load expense" },
        { category: "fetch", data: { url: "/api/expenses?x=1" } },
        { category: "console", message: "another line" },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "log", message: "Failed to load expense" },
      { category: "fetch", data: { url: "/api/expenses" } },
    ]);
  });

  it("tolerates an event without breadcrumbs", () => {
    expect(scrubEvent({ message: "x" })).toEqual({ message: "x" });
  });

  it("is idempotent", () => {
    const build = (): Event => ({
      message: "x ana@example.com",
      user: { id: USER_ID, email: "ana@example.com" },
      request: { url: "/api/a?b=1", headers: { cookie: "c", "user-agent": "UA" } },
    });
    const once = scrubEvent(build());
    expect(scrubEvent(structuredClone(once))).toEqual(once);
  });
});

describe("scrubSpan", () => {
  it("strips query strings from the name and URLs and drops identifying attributes", () => {
    const span = {
      name: "GET /api/expenses?search=ana@example.com",
      attributes: {
        "url.full": "https://homeshare.app/api/expenses?month=2026-06",
        "url.query": "month=2026-06",
        "http.request.header.cookie": ["homeshare_session=[Filtered]"],
        "http.request.header.authorization": ["Bearer x"],
        "client.address": "1.2.3.4",
        "user.email": "ana@example.com",
        "db.query.text": 'SELECT * FROM "User" WHERE id = $1',
        "http.response.status_code": 500,
        "sentry.op": "http.server",
        note: "hi ana@example.com",
      },
    };
    expect(scrubSpan(span)).toEqual({
      name: "GET /api/expenses",
      attributes: {
        "url.full": "https://homeshare.app/api/expenses",
        "db.query.text": 'SELECT * FROM "User" WHERE id = $1',
        "http.response.status_code": 500,
        "sentry.op": "http.server",
        note: "hi [email]",
      },
    });
  });

  it("filters DOM-attribute values from every string span attribute and from the span name (C1)", () => {
    const span = {
      name: 'button[aria-label="Actions for Ana #1"]',
      attributes: {
        "ui.element": 'li > span[title="Júlia Caminho Feliz"]',
        "sentry.description": '<img alt="Júlia Caminho Feliz" src=a>',
        "browser.web_vital.inp.target": 'div.flex > button[aria-label="Actions for Ana QA"]',
        "browser.web_vital.lcp.element": 'span[aria-label="Ana Souza"][title="Ana Souza"]',
        "browser.web_vital.cls.source.1": 'input[type="text"][aria-label="Percent of Ana"]',
        "browser.web_vital.lcp.id": "hero",
        "sentry.op": "ui.interaction.click",
      },
    };
    const scrubbed = scrubSpan(span);
    expect(scrubbed.name).toBe('button[aria-label="[Filtered]"]');
    expect(scrubbed.attributes).toEqual({
      "ui.element": 'li > span[title="[Filtered]"]',
      "sentry.description": '<img alt="[Filtered]" src=a>',
      "browser.web_vital.inp.target": 'div.flex > button[aria-label="[Filtered]"]',
      "browser.web_vital.lcp.element": 'span[aria-label="[Filtered]"][title="[Filtered]"]',
      "browser.web_vital.cls.source.1": 'input[type="[Filtered]"][aria-label="[Filtered]"]',
      "browser.web_vital.lcp.id": "hero",
      "sentry.op": "ui.interaction.click",
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/Ana|Júlia|Caminho/);
  });

  it("filters DOM-attribute values inside array-valued span attributes", () => {
    const scrubbed = scrubSpan({ name: "x", attributes: { "ui.elements": ['a[title="Ana Souza"]', "b"] } });
    expect(scrubbed.attributes).toEqual({ "ui.elements": ['a[title="[Filtered]"]', "b"] });
  });

  it("strips the query from sentry.segment.name (Next starts the root span as `${method} ${req.url}`) (I2)", () => {
    const span = {
      name: "GET",
      attributes: {
        "sentry.segment.name": "GET /api/auth/google/callback?code=abc&state=s",
        "segment.name": "GET /auth/set-password?token=abc",
        "sentry.op": "http.server",
      },
    };
    const scrubbed = scrubSpan(span);
    expect(scrubbed.attributes).toEqual({
      "sentry.segment.name": "GET /api/auth/google/callback",
      "segment.name": "GET /auth/set-password",
      "sentry.op": "http.server",
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/code=|state=|token=|abc/);
  });

  it("tolerates spans without attributes", () => {
    expect(scrubSpan({ name: "GET /api/health?db=1" })).toEqual({ name: "GET /api/health" });
  });

  it("strips the query from http.target, next.span_name and every other URL-holding attribute", () => {
    const span = {
      name: "GET",
      attributes: {
        "http.target": "/auth/set-password?token=abc",
        "next.span_name": "GET /api/auth/google/callback?code=abc&state=s",
        "http.url": "https://homeshare.app/api/expenses?month=2026-06#top",
        url: "/api/balances?x=1",
        "url.full": "https://oauth2.example.com/token?code=abc",
        "url.path": "/api/expenses",
        "url.fragment": "top",
        "http.query": "?token=abc",
        "http.route": "/api/expenses/[id]",
        "next.route": "/api/expenses/[id]",
      },
    };
    const scrubbed = scrubSpan(span);
    expect(scrubbed.attributes).toEqual({
      "http.target": "/auth/set-password",
      "next.span_name": "GET /api/auth/google/callback",
      "http.url": "https://homeshare.app/api/expenses",
      url: "/api/balances",
      "url.full": "https://oauth2.example.com/token",
      "url.path": "/api/expenses",
      "http.route": "/api/expenses/[id]",
      "next.route": "/api/expenses/[id]",
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/token=|code=|state=|month=|abc/);
  });

  it("drops every client-IP attribute (IPs are personal data under LGPD)", () => {
    const span = {
      name: "GET /api/expenses",
      attributes: {
        "network.peer.address": "203.0.113.7",
        "client.address": "203.0.113.7",
        "client.socket.address": "203.0.113.7",
        "net.peer.ip": "203.0.113.7",
        "net.sock.peer.addr": "203.0.113.7",
        "http.client_ip": "203.0.113.7",
        "user.ip_address": "203.0.113.7",
        "server.address": "homeshare.app",
        "http.request.method": "GET",
      },
    };
    const scrubbed = scrubSpan(span);
    expect(scrubbed.attributes).toEqual({ "server.address": "homeshare.app", "http.request.method": "GET" });
    expect(JSON.stringify(scrubbed)).not.toContain("203.0.113.7");
  });

  it("keeps only allowlisted header attributes, whatever the name separator or case", () => {
    const span = {
      name: "GET /api/expenses",
      attributes: {
        "http.request.header.x_forwarded_for": ["203.0.113.7"],
        "http.request.header.x-forwarded-for": ["203.0.113.7"],
        "http.request.header.x_real_ip": ["203.0.113.7"],
        "http.request.header.referer": ["https://homeshare.app/auth/set-password?token=abc"],
        "http.request.header.referrer": ["https://homeshare.app/x"],
        "http.request.header.cookie": ["homeshare_session=x"],
        "http.request.header.x_vercel_forwarded_for": ["203.0.113.7"],
        "http.request.header.user_agent": ["UA"],
        "http.request.header.Content-Type": ["application/json"],
        "http.request.header.content_length": ["12"],
        "http.request.header.accept_language": ["pt-BR"],
        "http.response.header.content_type": ["application/json"],
        "http.response.header.content_length": ["30"],
        "http.response.header.location": ["https://homeshare.app/auth/login?error=x"],
        "http.response.header.set_cookie": ["homeshare_session=x"],
      },
    };
    expect(scrubSpan(span).attributes).toEqual({
      "http.request.header.user_agent": ["UA"],
      "http.request.header.Content-Type": ["application/json"],
      "http.request.header.content_length": ["12"],
      "http.request.header.accept_language": ["pt-BR"],
      "http.response.header.content_type": ["application/json"],
      "http.response.header.content_length": ["30"],
    });
  });
});

// Spec 010, criterion 13: web-push POSTs each notice to the subscription's endpoint, a capability URL whose device token
// is its path (FCM, Mozilla, Apple) or its query (WNS). @sentry/nextjs records that request as an http breadcrumb
// (data.url) and a client span (name, url.full, url.path, server.address — @sentry/core's add-outgoing-request-breadcrumb
// and get-outgoing-span-data); a log line may quote it too. Only the push service's origin may leave the app.
describe("push-service endpoints (spec 010, criterion 13)", () => {
  const PUSH = [
    { name: "FCM", url: "https://fcm.googleapis.com/fcm/send/dXJsOnRva2Vu:APA91bH-SECRET_token", origin: "https://fcm.googleapis.com", path: "/fcm/send/dXJsOnRva2Vu:APA91bH-SECRET_token", query: undefined },
    { name: "Apple", url: "https://web.push.apple.com/QGxvbmd-SECRET_token", origin: "https://web.push.apple.com", path: "/QGxvbmd-SECRET_token", query: undefined },
    { name: "Mozilla", url: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-SECRET_token", origin: "https://updates.push.services.mozilla.com", path: "/wpush/v2/gAAAAABk-SECRET_token", query: undefined },
    { name: "WNS", url: "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB-SECRET%2btoken%3d", origin: "https://wns2-par02p.notify.windows.com", path: "/w/", query: "token=BQYAAAB-SECRET%2btoken%3d" },
  ];
  const CUT = (origin: string) => `${origin}/${FILTERED}`;

  it.each(PUSH)("redactText (the logger's text redaction) cuts a $name endpoint to its origin wherever it sits in the text", ({ url, origin }) => {
    expect(redactText(url)).toBe(CUT(origin));
    expect(redactText(`push to ${url} failed: socket hang up`)).toBe(`push to ${CUT(origin)} failed: socket hang up`);
    expect(redactText(`POST ${url}`)).toBe(`POST ${CUT(origin)}`);
    expect(redactText(`{"endpoint":"${url}"}`)).toBe(`{"endpoint":"${CUT(origin)}"}`);
    expect(redactText(redactText(url))).toBe(CUT(origin)); // idempotent
  });

  it("cuts whatever the scheme case, credentials or port, and a push URL nested in another URL's query", () => {
    expect(redactText("HTTPS://FCM.googleapis.com:443/fcm/send/SECRET")).toBe(`HTTPS://FCM.googleapis.com:443/${FILTERED}`);
    expect(redactText("https://u:p@fcm.googleapis.com/fcm/send/SECRET")).not.toContain("SECRET");
    expect(redactText("http://web.push.apple.com/SECRET")).toBe(`http://web.push.apple.com/${FILTERED}`);
    expect(redactText("https://homeshare.app/x?next=https://fcm.googleapis.com/fcm/send/SECRET")).toBe(
      `https://homeshare.app/x?next=https://fcm.googleapis.com/${FILTERED}`
    );
  });

  it("leaves every other URL alone: the app's own, a look-alike host, and a push origin with no path", () => {
    for (const text of [
      "https://homeshare.app/api/push-subscriptions",
      "https://oauth2.googleapis.com/token",
      "https://evilfcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.com/fcm/send/x",
      "https://fcm.googleapis.com",
      "https://fcm.googleapis.com/",
      "POST fcm.googleapis.com",
      "/fcm/send/x",
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it.each(PUSH)("scrubEvent cuts web-push's outgoing http breadcrumb ($name) and the endpoint anywhere else in the event", ({ url, origin, path, query }) => {
    // The breadcrumb as @sentry/core builds it: url = protocol + host + path (the query goes to url.query).
    const event = scrubEvent({
      message: `push failed for ${url}`,
      exception: { values: [{ type: "WebPushError", value: `Received unexpected response code ${url}` }] },
      extra: { endpoint: url },
      breadcrumbs: [
        {
          category: "http",
          type: "http",
          level: "info",
          data: { status_code: 201, url: origin + path, "http.request.method": "POST", "url.query": query, "url.fragment": undefined },
        },
        { category: "log", level: "warning", message: `push delivery failed ${url}` },
      ],
    });
    expect(event.breadcrumbs).toEqual([
      { category: "http", type: "http", level: "info", data: { status_code: 201, url: CUT(origin), "http.request.method": "POST" } },
      { category: "log", level: "warning", message: `push delivery failed ${CUT(origin)}` },
    ]);
    expect(event.message).toBe(`push failed for ${CUT(origin)}`);
    expect(event.exception?.values?.[0]?.value).toBe(`Received unexpected response code ${CUT(origin)}`);
    expect(event.extra).toEqual({ endpoint: CUT(origin) });
    expect(JSON.stringify(event)).not.toContain("SECRET");
  });

  it.each(PUSH)("scrubSpan cuts web-push's client span ($name): name, url.full, http.url, url.path and http.target", ({ url, origin, path, query }) => {
    const host = new URL(url).hostname;
    // The span as @sentry/core builds it (static lifecycle name; legacy http.* keys included for older instrumentation).
    const span = {
      name: `POST ${url}`,
      attributes: {
        "sentry.op": "http.client",
        "sentry.origin": "auto.http.client",
        "sentry.kind": "client",
        "http.request.method": "POST",
        "url.full": url,
        "url.path": path,
        "url.query": query,
        "url.scheme": "https:",
        "url.domain": host,
        "server.address": host,
        "server.port": 443,
        "http.url": url,
        "http.target": query ? `${path}?${query}` : path,
        "http.response.status_code": 201,
      },
    };
    expect(scrubSpan(span)).toEqual({
      name: `POST ${CUT(origin)}`,
      attributes: {
        "sentry.op": "http.client",
        "sentry.origin": "auto.http.client",
        "sentry.kind": "client",
        "http.request.method": "POST",
        "url.full": CUT(origin),
        "url.path": `/${FILTERED}`,
        "url.scheme": "https:",
        "url.domain": host,
        "server.address": host,
        "server.port": 443,
        "http.url": CUT(origin),
        "http.target": `/${FILTERED}`,
        "http.response.status_code": 201,
      },
    });
    expect(JSON.stringify(span)).not.toContain("SECRET");
  });

  it("drops the host-less path of a push request named by any host attribute (the streamed span name is `POST <host>`)", () => {
    const streamed = scrubSpan({
      name: "POST fcm.googleapis.com",
      attributes: { "server.address": "fcm.googleapis.com", "url.path": "/fcm/send/SECRET" },
    });
    expect(streamed).toEqual({ name: "POST fcm.googleapis.com", attributes: { "server.address": "fcm.googleapis.com", "url.path": `/${FILTERED}` } });
    const legacy = scrubSpan({ name: "POST", attributes: { "http.host": "web.push.apple.com:443", "http.target": "/SECRET" } });
    expect(legacy.attributes).toEqual({ "http.host": "web.push.apple.com:443", "http.target": `/${FILTERED}` });
    const peer = scrubSpan({ name: "POST", attributes: { "net.peer.name": "updates.push.services.mozilla.com", "http.target": "/wpush/v2/SECRET" } });
    expect(peer.attributes).toEqual({ "net.peer.name": "updates.push.services.mozilla.com", "http.target": `/${FILTERED}` });
  });

  it("keeps url.path and http.target of every other outgoing request", () => {
    const span = scrubSpan({
      name: "POST https://oauth2.googleapis.com/token",
      attributes: { "server.address": "oauth2.googleapis.com", "url.domain": "evilfcm.googleapis.com", "url.path": "/token", "http.target": "/token" },
    });
    expect(span).toEqual({
      name: "POST https://oauth2.googleapis.com/token",
      attributes: { "server.address": "oauth2.googleapis.com", "url.domain": "evilfcm.googleapis.com", "url.path": "/token", "http.target": "/token" },
    });
  });
});

describe("redactText — hardening from the POC 010 re-review", () => {
  it("a long chain of nested non-push URLs no longer overflows the stack (iterative scan)", () => {
    const chain = "http://a/".repeat(5000);
    expect(() => redactText(chain)).not.toThrow();
    expect(redactText(chain)).toBe(chain);
  });

  it("still finds a push URL at the end of a long nested chain", () => {
    const chain = `${"http://a/?u=".repeat(3000)}https://fcm.googleapis.com/fcm/send/TOKEN123`;
    const out = redactText(chain);
    expect(out).not.toContain("TOKEN123");
    expect(out.endsWith(`https://fcm.googleapis.com/${FILTERED}`)).toBe(true);
  });

  it("cuts a push URL whose host ends in a dot", () => {
    expect(redactText("POST https://fcm.googleapis.com./fcm/send/TOKEN123")).toBe(
      `POST https://fcm.googleapis.com./${FILTERED}`
    );
  });

  it("cuts a scheme-less push host + path, and leaves an already cut URL alone", () => {
    expect(redactText("peer fcm.googleapis.com/fcm/send/TOKEN123 done")).toBe(`peer fcm.googleapis.com/${FILTERED} done`);
    expect(redactText("web.push.apple.com/QGuQyavXut")).toBe(`web.push.apple.com/${FILTERED}`);
    expect(redactText(`https://fcm.googleapis.com/${FILTERED}`)).toBe(`https://fcm.googleapis.com/${FILTERED}`);
    expect(redactText("see example.com/fcm.googleapis.com/x")).toBe("see example.com/fcm.googleapis.com/x");
  });

  it("cuts a scheme-less URL on every host of PUSH_SERVICE_HOSTS, and on a subdomain of each", () => {
    for (const host of PUSH_SERVICE_HOSTS) {
      expect(redactText(`at ${host}/device-TOKEN`)).toBe(`at ${host}/${FILTERED}`);
      expect(redactText(`at edge.${host}/device-TOKEN`)).toBe(`at edge.${host}/${FILTERED}`);
    }
  });

  it("matches the hosts' dots literally (escaped), not as any character", () => {
    expect(redactText("at fcmXgoogleapis.com/device-TOKEN")).toBe("at fcmXgoogleapis.com/device-TOKEN");
    expect(redactText("at push.appleXcom/device-TOKEN")).toBe("at push.appleXcom/device-TOKEN");
  });

  // Cycle G review M7: one host list. A push service added to src/lib/push/hosts.ts is cut without a scheme too.
  it("builds the scheme-less pattern from PUSH_SERVICE_HOSTS (a host added there is covered here)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/push/hosts", async (importOriginal) => {
      const actual = await importOriginal<typeof Hosts>();
      const hosts = [...actual.PUSH_SERVICE_HOSTS, "push.example-vendor.net"];
      return { ...actual, PUSH_SERVICE_HOSTS: hosts, isPushServiceHost: (host: string) => hosts.some((h) => host === h || host.endsWith(`.${h}`)) };
    });
    try {
      const fresh = await import("./scrub");
      expect(fresh.redactText("at push.example-vendor.net/device-TOKEN")).toBe(`at push.example-vendor.net/${FILTERED}`);
      expect(fresh.redactText("at fcm.googleapis.com/device-TOKEN")).toBe(`at fcm.googleapis.com/${FILTERED}`);
    } finally {
      vi.doUnmock("@/lib/push/hosts");
      vi.resetModules();
    }
  });

  it("e-mail redaction is linear on long letter runs (bounded parts)", () => {
    const run = "a".repeat(64 * 1024);
    const started = Date.now();
    expect(redactText(run)).toBe(run);
    expect(Date.now() - started).toBeLessThan(500);
    expect(redactText("contato: ana.souza+x@example.com.br")).toBe("contato: [email]");
  });
});
