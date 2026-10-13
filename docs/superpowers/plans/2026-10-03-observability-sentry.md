# Observability with Sentry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an env-guarded, privacy-first observability layer: server 5xx and client crashes captured in Sentry with opaque context, tracing with DB spans and Web Vitals, JSON server logs, a Sentry dashboard defined as code, and the owner's setup checklist — with zero behaviour or build change when no DSN is configured.

**Architecture:** `@sentry/nextjs@11.4.0` (exact pin) is initialized from `src/instrumentation.ts` (server + edge) and `src/instrumentation-client.ts` (browser) through one helper, `initSentry`, that does nothing without a DSN; options come from a pure builder with an explicit restrictive `dataCollection` (SDK v11 defaults are permissive) and tested scrubbers (`scrubEvent` → `beforeSend`, `scrubSpan` → `beforeSendSpan`). `next.config.ts` applies `withSentryConfig` (tunnel `/monitoring`, token-gated source maps) only when a DSN exists at build time. The single route catch, `handleApiError`, becomes async: 4xx `ApiError`s are answered as today and never reported; everything else is answered as today, captured once and logged once (JSON line) with `route` / `http_status` / `api_error_code` / `request_id` read from headers the middleware stamps. `requireSession` / `requireActiveGroup` and the client `SessionProvider` attach only `publicId`s. No schema change, no endpoint change.

**Tech Stack:** Next.js 16.1 App Router (Turbopack), React 19, `@sentry/nextjs` 11.4.0, Prisma 7 + `@prisma/adapter-pg`, next-intl 4 (EN/PT/ES/FR), Vitest 3 + pglite, Vercel serverless.

**Spec:** `docs/specs/007-observability-sentry/` (requirements R1–R16, design, tasks) · ADR `docs/decisions/0008-observability-sentry.md` (created by Task 11) · ADR 0001 (cookie auth) and 0002 (active house) — read, never changed · SDK reference: `@sentry/nextjs` 11.x docs + `MIGRATION.md` v10→v11 (`dataCollection`, span streaming, `@sentry/nextjs/config`, tunnel through middleware).

## Global Constraints

- Build on the CURRENT working tree (≈60 unstaged files from the UI-loop phases; the suite count recorded in Task 1 Step 1 is the baseline), not on HEAD. Never `git stash`, `git checkout --`, or reset those files.
- English in all code, comments, identifiers and URLs. UI text only through `src/messages/{en,pt,es,fr}.json`: every new key in all 4 files; change values, never keys, of existing messages unless the task says so.
- `cn()` in `src/components/ui/cn.ts` only joins strings (no tailwind-merge): never stack two utilities for the same CSS property at the same breakpoint.
- Money is integer cents (`lib/currency`: `toCents`/`fromCents`/`splitCents`); DB is `Decimal(10,2)` and API amounts serialize as strings; comparisons are exact (no epsilon).
- API errors carry a `code` translated client-side (`useApiError`, namespaces `ApiErrors`/`CsvErrors`).
- Tenant isolation via `requireActiveGroup`; `groupId` never comes from the body.
- Mobile-first (44px touch floor below `md`, spec 003 criterion 7); animations stay behind `prefers-reduced-motion`.
- Gates per task: `npm run test` green, `npx tsc --noEmit` clean, `npx eslint src` with no new errors (1 pre-existing error in `src/app/auth/login/page.tsx`).
- i18n parity check (run after every task that touches messages; must print `i18n parity OK`):
  ```bash
  node -e 'const f=o=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==="object"?f(v).map(s=>k+"."+s):[k]);const L=["en","pt","es","fr"].map(l=>new Set(f(require("./src/messages/"+l+".json"))));const all=new Set(L.flatMap(s=>[...s]));const miss=[...all].filter(k=>!L.every(s=>s.has(k)));console.log(miss.length?"MISSING "+miss.join(", "):"i18n parity OK")'
  ```
- **NO commits.** Leave every change unstaged — the owner commits later on a branch he picks.
- NEVER run `npm run build`, `next build` (it loads `.env.local`), `prisma db push`, or anything that reads `.env` / `.env.local` (they point at the PRODUCTION Neon DB). This plan needs no schema change and no Prisma generator change.
- Dependency install is exactly `npm install --save-exact @sentry/nextjs@11.4.0` (Task 1; `--save-exact` only pins the range in `package.json`). No other new dependency.
- No real DSN, auth token or org slug in any file. Tests use fakes (`https://k@o1.ingest.sentry.io/2`, `sntrys_test`); QA uses a local stub DSN. No test may touch the network: every test that asserts SDK calls mocks `@sentry/nextjs`.
- Implementers do not start dev servers or browsers; the controller verifies on the QA server at 127.0.0.1:3100 (Task 12).

## Task order and shared files

Tasks run in order (1 → 12). Files touched by more than one task: `src/lib/logger.test.ts` (5, 7), `src/lib/observability/scrub.ts` (2, read by 3 and 5), `docs/specs/007-observability-sentry/tasks.md` (12). Search by content — line numbers drift.

---

### Task 1: Install `@sentry/nextjs` 11.4.0 and verify compatibility

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm only)

**Interfaces:**
- Produces: dependency `"@sentry/nextjs": "11.4.0"` (exact). Entry points used later: `@sentry/nextjs` (runtime) and `@sentry/nextjs/config` (`withSentryConfig`, build only).

- [ ] **Step 1: Record the baseline.** Run `npm run test` and note the number of passing tests (≈306); run `npx tsc --noEmit` (clean).
- [ ] **Step 2: Install.**
  ```bash
  npm install --save-exact @sentry/nextjs@11.4.0
  ```
  Expected: `package.json` `dependencies` gains `"@sentry/nextjs": "11.4.0"` (no caret) and nothing else changes in `dependencies`/`devDependencies`.
- [ ] **Step 3: Verify the runtime entry, ranges and the Prisma 7 helper.**
  ```bash
  npm ls @sentry/nextjs
  node -e "const m=require('@sentry/nextjs');console.log(typeof m.init, typeof m.captureException, typeof m.captureRequestError, typeof m.addBreadcrumb)"
  node -e "const p=require('./node_modules/@sentry/nextjs/package.json');console.log(p.version, JSON.stringify(p.peerDependencies), JSON.stringify(p.engines))"
  grep -rl --include=*.js "V7_PRISMA_INSTRUMENTATION" node_modules/@sentry | head -1
  ```
  Expected: `@sentry/nextjs@11.4.0`; `function function function function`; `11.4.0 {"next":"^14.0 || ^15.0.0-rc.0 || ^16.0.0-0"} {"node":">=20.19.0 <22.0.0 || >=22.12.0 <23.0.0 || >=23.2.0"}`; one file path (the Prisma 6/7 global tracing helper — no `previewFeatures`, no schema change). If any line differs, stop and report BLOCKED with the output.
- [ ] **Step 4: Gates.** `npm run test` (same count as Step 1), `npx tsc --noEmit`.

---

### Task 2: Scrubbers — `scrubEvent`, `scrubSpan`, `redactText`, `stripQuery` (R4, R5)

**Files:**
- Create: `src/lib/observability/scrub.ts`
- Test: `src/lib/observability/scrub.test.ts`

**Interfaces:**
- Produces (`src/lib/observability/scrub.ts`):
  - `export const FILTERED = "[Filtered]"`
  - `export const ALLOWED_REQUEST_HEADERS: string[]` (`user-agent`, `content-type`, `content-length`, `accept-language`)
  - `export const ALLOWED_RESPONSE_HEADERS: string[]` (`content-type`, `content-length`)
  - `export function redactText(text: string): string`
  - `export function stripQuery(url: string): string`
  - `export function scrubEvent<T extends Event>(event: T): T` (`Event` type from `@sentry/nextjs`, type-only import)
  - `export function scrubSpan<T extends object>(span: T): T`

- [ ] **Step 1: Write the failing tests.** Create `src/lib/observability/scrub.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import type { Event } from "@sentry/nextjs";
  import { FILTERED, redactText, scrubEvent, scrubSpan, stripQuery } from "./scrub";

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

    it("tolerates spans without attributes", () => {
      expect(scrubSpan({ name: "GET /api/health?db=1" })).toEqual({ name: "GET /api/health" });
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/observability/scrub.test.ts` → FAIL (`Cannot find module './scrub'`).
- [ ] **Step 3: Implement.** Create `src/lib/observability/scrub.ts`:
  ```ts
  import type { Event } from "@sentry/nextjs";

  /** Replacement for any value that must never leave the app (spec 007, LGPD). */
  export const FILTERED = "[Filtered]";

  /** The only request headers that may reach Sentry — never cookies, auth or client IPs. */
  export const ALLOWED_REQUEST_HEADERS: string[] = ["user-agent", "content-type", "content-length", "accept-language"];
  /** The only response headers that may reach Sentry. */
  export const ALLOWED_RESPONSE_HEADERS: string[] = ["content-type", "content-length"];

  // Keys whose VALUE is always secret or personal, wherever they appear (compared lowercased, without - and _).
  const SENSITIVE_KEYS = new Set([
    "cookie", "cookies", "setcookie", "authorization", "proxyauthorization",
    "password", "newpassword", "currentpassword", "token", "accesstoken", "refreshtoken", "idtoken",
    "secret", "clientsecret", "jwt", "joincode", "email", "homesharesession", "homesharegroup",
  ]);
  const MAX_DEPTH = 12;
  // SDK-internal (never serialized) and may hold live scope objects — mutating it would corrupt the SDK.
  const SKIPPED_EVENT_KEYS = new Set(["sdkProcessingMetadata"]);
  const REQUEST_FIELDS_TO_DROP = ["cookies", "data", "env", "query_string"];
  const BREADCRUMB_URL_KEYS = ["url", "from", "to"];

  // JSON.parse errors echo the start of the body: Unexpected token 'o', "not json a"... is not valid JSON
  const JSON_PARSE_SNIPPET = /"[\s\S]*"(?:\.\.\.)? is not valid JSON/g;
  const SESSION_COOKIE_VALUE = /\b(homeshare_session|homeshare_group)=[^;\s,"']+/gi;
  const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
  const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  const DROPPED_SPAN_ATTRIBUTE =
    /cookie|authorization|^url\.query$|^http\.query$|^user\.(email|ip_address|name|username)$|^client\.address$/i;
  const URL_SPAN_ATTRIBUTES = new Set(["url.full", "http.url", "url"]);

  /** Redacts e-mails, session/group cookie values, bearer tokens, JWTs and JSON-parse body snippets. */
  export function redactText(text: string): string {
    return text
      .replace(JSON_PARSE_SNIPPET, `"${FILTERED}" is not valid JSON`)
      .replace(SESSION_COOKIE_VALUE, `$1=${FILTERED}`)
      .replace(BEARER_TOKEN, `Bearer ${FILTERED}`)
      .replace(JWT, "[jwt]")
      .replace(EMAIL, "[email]");
  }

  /** Drops the query string and the fragment of a URL or path. */
  export function stripQuery(url: string): string {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }

  function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
  }

  function walk(value: unknown, depth: number): unknown {
    if (typeof value === "string") return redactText(value);
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i], depth + 1);
      return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = isSensitiveKey(key) ? FILTERED : walk(record[key], depth + 1);
    }
    return record;
  }

  function allowlisted(headers: Record<string, string>): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (ALLOWED_REQUEST_HEADERS.includes(name.toLowerCase())) kept[name] = value;
    }
    return kept;
  }

  function lastLine(text: string): string {
    return text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
  }

  /**
   * beforeSend hook (spec 007): strips everything personal or secret from an error event. No I/O, no
   * SDK import (types only), idempotent. It mutates and returns the event it is given — Sentry's
   * documented beforeSend pattern: cloning would copy SDK-internal objects, and a throwing hook drops
   * the event.
   */
  export function scrubEvent<T extends Event>(event: T): T {
    const request = event.request as unknown as (Record<string, unknown> & { url?: string; headers?: Record<string, string> }) | undefined;
    if (request) {
      for (const field of REQUEST_FIELDS_TO_DROP) delete request[field];
      if (typeof request.url === "string") request.url = stripQuery(request.url);
      if (request.headers) request.headers = allowlisted(request.headers);
    }
    if (event.user) {
      const id = event.user.id;
      if (id === undefined || id === null || id === "") delete event.user;
      else event.user = { id };
    }
    if (event.transaction) event.transaction = stripQuery(event.transaction);
    for (const crumb of event.breadcrumbs ?? []) {
      const data = crumb.data;
      if (!data) continue;
      for (const key of BREADCRUMB_URL_KEYS) {
        if (typeof data[key] === "string") data[key] = stripQuery(data[key]);
      }
    }
    // Prisma's "Invalid `prisma.x.y()` invocation" message prints the query arguments (names, amounts);
    // keep only the final reason line — the stack trace already shows the call site.
    for (const exception of event.exception?.values ?? []) {
      if (exception.type?.startsWith("PrismaClient") && exception.value) exception.value = lastLine(exception.value);
    }
    const record = event as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!SKIPPED_EVENT_KEYS.has(key)) record[key] = walk(record[key], 1);
    }
    return event;
  }

  /** beforeSendSpan hook (spec 007): no query strings, no identifying attributes. Mutates and returns the span. */
  export function scrubSpan<T extends object>(span: T): T {
    const target = span as unknown as { name?: unknown; attributes?: Record<string, unknown> };
    if (typeof target.name === "string") target.name = redactText(stripQuery(target.name));
    const attributes = target.attributes;
    if (!attributes) return span;
    for (const key of Object.keys(attributes)) {
      const value = attributes[key];
      if (DROPPED_SPAN_ATTRIBUTE.test(key)) delete attributes[key];
      else if (typeof value === "string") attributes[key] = redactText(URL_SPAN_ATTRIBUTES.has(key) ? stripQuery(value) : value);
      else if (Array.isArray(value)) attributes[key] = value.map((item) => (typeof item === "string" ? redactText(item) : item));
    }
    return span;
  }
  ```
- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/observability/scrub.test.ts` → all pass.
- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 3: SDK options and the env-guarded `initSentry` (R1, R3, R14)

**Files:**
- Create: `src/lib/observability/options.ts`, `src/lib/observability/init.ts`
- Test: `src/lib/observability/options.test.ts`, `src/lib/observability/init.test.ts`

**Interfaces:**
- Consumes: `scrubEvent`, `scrubSpan`, `ALLOWED_REQUEST_HEADERS`, `ALLOWED_RESPONSE_HEADERS` (Task 2).
- Produces (`options.ts`): `export type SentryInitOptions = NonNullable<Parameters<typeof init>[0]>`; `export interface SentryEnv { dsn: string | undefined; environment: string | undefined; tracesSampleRate: string | undefined }`; `export function resolveTracesSampleRate(raw: string | undefined, environment: string): number`; `export function buildSentryOptions(env: SentryEnv): SentryInitOptions | null`.
- Produces (`init.ts`): `export function initSentry(env: SentryEnv): boolean` — `false` and no `Sentry.init` call without a DSN.

- [ ] **Step 1: Check the v11 option names before coding.** Open `node_modules/@sentry/core/build/types/` and search for `dataCollection?:`, `beforeSendSpan?:` and `ignoreSpans?:`; confirm the keys `userInfo`, `cookies`, `httpHeaders` (`request`/`response` accepting `{ allow: string[] }`), `httpBodies`, `urlQueryParams`, `genAI`, `databaseQueryData`, `queues`, `graphQL`, `stackFrameVariables` exist (they come from MIGRATION.md's "keep the v10 default behavior" block plus its defaults table). If one key does not exist in 11.4.0, omit only that key — both in `buildSentryOptions` (Step 4) and in the `dataCollection` `toEqual` of `options.test.ts` (Step 2) — and list it in the task report.
- [ ] **Step 2: Write the failing tests.** Create `src/lib/observability/options.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { buildSentryOptions, resolveTracesSampleRate } from "./options";
  import { scrubEvent, scrubSpan } from "./scrub";

  const DSN = "https://k@o1.ingest.sentry.io/2";

  describe("resolveTracesSampleRate (R14)", () => {
    it.each<[string | undefined, string, number]>([
      [undefined, "production", 0.1],
      [undefined, "preview", 1],
      [undefined, "development", 1],
      ["", "production", 0.1],
      ["0.25", "production", 0.25],
      ["0", "production", 0],
      ["1", "production", 1],
      ["abc", "production", 0.1],
      ["1.5", "development", 1],
      ["-0.1", "production", 0.1],
    ])("raw %s in %s → %s", (raw, environment, expected) => {
      expect(resolveTracesSampleRate(raw, environment)).toBe(expected);
    });
  });

  describe("buildSentryOptions", () => {
    it.each([undefined, "", "   "])("returns null without a DSN (%j)", (dsn) => {
      expect(buildSentryOptions({ dsn, environment: "production", tracesSampleRate: undefined })).toBeNull();
    });

    it("sets every data-collection category to the restrictive side (v11 defaults are permissive) — R3", () => {
      const options = buildSentryOptions({ dsn: ` ${DSN} `, environment: "production", tracesSampleRate: undefined });
      expect(options).toMatchObject({ dsn: DSN, environment: "production", tracesSampleRate: 0.1 });
      expect(options?.dataCollection).toEqual({
        userInfo: false,
        cookies: false,
        httpHeaders: {
          request: { allow: ["user-agent", "content-type", "content-length", "accept-language"] },
          response: { allow: ["content-type", "content-length"] },
        },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
        stackFrameVariables: false,
      });
    });

    it("defaults the environment to development (full sampling)", () => {
      expect(buildSentryOptions({ dsn: DSN, environment: undefined, tracesSampleRate: undefined }))
        .toMatchObject({ environment: "development", tracesSampleRate: 1 });
    });

    it("drops health-check spans and wires the scrubbers", () => {
      const options = buildSentryOptions({ dsn: DSN, environment: "preview", tracesSampleRate: "0.5" });
      expect(options?.tracesSampleRate).toBe(0.5);
      expect(options?.ignoreSpans).toEqual([/\/api\/health/]);
      expect(options?.beforeSend).toBe(scrubEvent);
      expect(options?.beforeSendSpan).toBe(scrubSpan);
    });
  });
  ```
  Create `src/lib/observability/init.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const { mockInit } = vi.hoisted(() => ({ mockInit: vi.fn() }));
  vi.mock("@sentry/nextjs", () => ({ init: mockInit }));

  import { initSentry } from "./init";

  const DSN = "https://k@o1.ingest.sentry.io/2";

  beforeEach(() => {
    mockInit.mockReset();
  });

  describe("initSentry — env guard (R1)", () => {
    it("does not initialize the SDK without a DSN", () => {
      expect(initSentry({ dsn: undefined, environment: "production", tracesSampleRate: undefined })).toBe(false);
      expect(initSentry({ dsn: "  ", environment: "production", tracesSampleRate: undefined })).toBe(false);
      expect(mockInit).not.toHaveBeenCalled();
    });

    it("initializes once with the privacy-first options when a DSN is set", () => {
      expect(initSentry({ dsn: DSN, environment: "preview", tracesSampleRate: undefined })).toBe(true);
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockInit.mock.calls[0][0]).toMatchObject({
        dsn: DSN,
        environment: "preview",
        tracesSampleRate: 1,
        dataCollection: { userInfo: false, cookies: false, httpBodies: [], databaseQueryData: false },
      });
    });
  });
  ```
- [ ] **Step 3: Run to verify they fail.** `npx vitest run src/lib/observability/options.test.ts src/lib/observability/init.test.ts` → FAIL (modules missing).
- [ ] **Step 4: Implement.** Create `src/lib/observability/options.ts`:
  ```ts
  import type { init } from "@sentry/nextjs";
  import { ALLOWED_REQUEST_HEADERS, ALLOWED_RESPONSE_HEADERS, scrubEvent, scrubSpan } from "@/lib/observability/scrub";

  /** What Sentry.init accepts in whichever runtime (browser, Node, edge) imports this module. */
  export type SentryInitOptions = NonNullable<Parameters<typeof init>[0]>;

  /** Raw env values — each runtime passes its own (NEXT_PUBLIC_* literals in the browser). */
  export interface SentryEnv {
    dsn: string | undefined;
    environment: string | undefined;
    tracesSampleRate: string | undefined;
  }

  const PRODUCTION_TRACES_SAMPLE_RATE = 0.1;
  const DEFAULT_TRACES_SAMPLE_RATE = 1.0;

  /** The env value when it is a number in [0, 1]; otherwise 0.1 in production and 1.0 anywhere else. */
  export function resolveTracesSampleRate(raw: string | undefined, environment: string): number {
    if (raw !== undefined && raw.trim() !== "") {
      const rate = Number(raw);
      if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return rate;
    }
    return environment === "production" ? PRODUCTION_TRACES_SAMPLE_RATE : DEFAULT_TRACES_SAMPLE_RATE;
  }

  /**
   * Options for every runtime, or null when no DSN is configured (the SDK must then stay off — R1).
   * SDK v11 removed sendDefaultPii and made dataCollection PERMISSIVE by default (cookies, bodies, DB
   * query data, user info), so every category is set explicitly here (spec 007, LGPD).
   */
  export function buildSentryOptions(env: SentryEnv): SentryInitOptions | null {
    const dsn = env.dsn?.trim();
    if (!dsn) return null;
    const environment = env.environment?.trim() || "development";
    return {
      dsn,
      environment,
      tracesSampleRate: resolveTracesSampleRate(env.tracesSampleRate, environment),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: {
          request: { allow: ALLOWED_REQUEST_HEADERS },
          response: { allow: ALLOWED_RESPONSE_HEADERS },
        },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        graphQL: { document: false, variables: false },
        stackFrameVariables: false,
      },
      // The keep-warm cron (BL-15) pings /api/health every few minutes — pure noise in traces.
      ignoreSpans: [/\/api\/health/],
      beforeSend: scrubEvent,
      beforeSendSpan: scrubSpan,
    };
  }
  ```
  Create `src/lib/observability/init.ts`:
  ```ts
  import * as Sentry from "@sentry/nextjs";
  import { buildSentryOptions, type SentryEnv } from "@/lib/observability/options";

  /** Initializes the SDK for the calling runtime; returns false — and does nothing — without a DSN. */
  export function initSentry(env: SentryEnv): boolean {
    const options = buildSentryOptions(env);
    if (!options) return false;
    Sentry.init(options);
    return true;
  }
  ```
- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/lib/observability/options.test.ts src/lib/observability/init.test.ts` → all pass.
- [ ] **Step 6: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 4: Request context headers + middleware (R11, R12)

**Files:**
- Create: `src/lib/observability/request-context.ts`
- Test: `src/lib/observability/request-context.test.ts`
- Modify: `src/middleware.ts`
- Create: `src/middleware.test.ts`

**Interfaces:**
- Produces (`request-context.ts`, edge-safe — no Next imports): `REQUEST_ID_HEADER = "x-homeshare-request-id"`, `REQUEST_PATH_HEADER = "x-homeshare-path"`, `REQUEST_START_HEADER = "x-homeshare-start"`; `export interface RequestContext { requestId?: string; route?: string; durationMs?: number }`; `export function normalizeRoute(pathname: string): string`; `export function stampRequestContext(source: Headers, pathname: string, now?: number, requestId?: string): Headers`; `export function readRequestContext(headers: Pick<Headers, "get">, now?: number): RequestContext`.
- Produces (middleware): pass-through responses forward the three headers to the handler; `config.matcher` excludes `monitoring`.

- [ ] **Step 1: Write the failing tests.** Create `src/lib/observability/request-context.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import {
    REQUEST_ID_HEADER,
    REQUEST_PATH_HEADER,
    REQUEST_START_HEADER,
    normalizeRoute,
    readRequestContext,
    stampRequestContext,
  } from "./request-context";

  describe("normalizeRoute", () => {
    it.each([
      ["/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc/history", "/api/expenses/:id/history"],
      ["/api/groups/active/members/42", "/api/groups/active/members/:id"],
      ["/api/health", "/api/health"],
      ["/", "/"],
    ])("%s → %s", (pathname, expected) => {
      expect(normalizeRoute(pathname)).toBe(expected);
    });
  });

  describe("stampRequestContext", () => {
    it("stamps id, path and start, preferring Vercel's request id", () => {
      const headers = stampRequestContext(new Headers({ "x-vercel-id": "gru1::iad1::abc-123" }), "/api/expenses", 1000);
      expect(headers.get(REQUEST_ID_HEADER)).toBe("gru1::iad1::abc-123");
      expect(headers.get(REQUEST_PATH_HEADER)).toBe("/api/expenses");
      expect(headers.get(REQUEST_START_HEADER)).toBe("1000");
    });

    it("overwrites client-supplied values and generates an id off Vercel", () => {
      const forged = new Headers({ [REQUEST_ID_HEADER]: "forged", [REQUEST_PATH_HEADER]: "/x", [REQUEST_START_HEADER]: "1" });
      const headers = stampRequestContext(forged, "/api/shopping-items", 2000);
      expect(headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(headers.get(REQUEST_PATH_HEADER)).toBe("/api/shopping-items");
      expect(headers.get(REQUEST_START_HEADER)).toBe("2000");
    });
  });

  describe("readRequestContext", () => {
    it("returns the id, the normalized route and the elapsed time", () => {
      const headers = new Headers({
        [REQUEST_ID_HEADER]: "gru1::iad1::abc-123",
        [REQUEST_PATH_HEADER]: "/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc",
        [REQUEST_START_HEADER]: "1000",
      });
      expect(readRequestContext(headers, 1250)).toEqual({ requestId: "gru1::iad1::abc-123", route: "/api/expenses/:id", durationMs: 250 });
    });

    it("ignores missing, malformed or future values", () => {
      expect(readRequestContext(new Headers(), 1000)).toEqual({});
      const bad = new Headers({ [REQUEST_ID_HEADER]: "has spaces", [REQUEST_PATH_HEADER]: "api/x", [REQUEST_START_HEADER]: "5000" });
      expect(readRequestContext(bad, 1000)).toEqual({});
    });
  });
  ```
  Create `src/middleware.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { NextRequest } from "next/server";
  import { config, middleware } from "./middleware";
  import { REQUEST_ID_HEADER, REQUEST_PATH_HEADER } from "@/lib/observability/request-context";

  const matches = (pathname: string) => new RegExp(`^${config.matcher[0]}$`).test(pathname);

  describe("middleware matcher (spec 007)", () => {
    it("never runs on the Sentry tunnel or static assets", () => {
      expect(matches("/monitoring")).toBe(false);
      expect(matches("/_next/static/chunks/app.js")).toBe(false);
    });

    it("still guards pages and APIs", () => {
      expect(matches("/expenses")).toBe(true);
      expect(matches("/api/expenses")).toBe(true);
      expect(matches("/api/health")).toBe(true);
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
  });
  ```
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/lib/observability/request-context.test.ts src/middleware.test.ts` → FAIL (module missing; `/monitoring` still matched).
- [ ] **Step 3: Implement the helpers.** Create `src/lib/observability/request-context.ts`:
  ```ts
  // Request-scoped observability context (spec 007). The middleware stamps these headers on every
  // request it lets through (always overwriting client values); handleApiError reads them for the log
  // line and the Sentry tags. Edge-safe: no Next imports.

  export const REQUEST_ID_HEADER = "x-homeshare-request-id";
  export const REQUEST_PATH_HEADER = "x-homeshare-path";
  export const REQUEST_START_HEADER = "x-homeshare-start";

  export interface RequestContext {
    requestId?: string;
    route?: string;
    durationMs?: number;
  }

  const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const NUMERIC_SEGMENT = /^\d+$/;
  const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

  /** Low-cardinality route for dashboards: UUID and numeric path segments become ":id". */
  export function normalizeRoute(pathname: string): string {
    const route = pathname
      .split("/")
      .map((segment) => (UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) ? ":id" : segment))
      .join("/");
    return route || "/";
  }

  /** Copy of the request headers with fresh id/path/start values (Vercel's request id when present). */
  export function stampRequestContext(
    source: Headers,
    pathname: string,
    now: number = Date.now(),
    requestId: string = source.get("x-vercel-id") ?? crypto.randomUUID()
  ): Headers {
    const headers = new Headers(source);
    headers.set(REQUEST_ID_HEADER, requestId);
    headers.set(REQUEST_PATH_HEADER, pathname);
    headers.set(REQUEST_START_HEADER, String(now));
    return headers;
  }

  /** Reads and validates the stamped values; anything missing or malformed is left out. */
  export function readRequestContext(headers: Pick<Headers, "get">, now: number = Date.now()): RequestContext {
    const context: RequestContext = {};
    const requestId = headers.get(REQUEST_ID_HEADER);
    if (requestId && SAFE_REQUEST_ID.test(requestId)) context.requestId = requestId;
    const path = headers.get(REQUEST_PATH_HEADER);
    if (path && path.startsWith("/")) context.route = normalizeRoute(path);
    const start = Number(headers.get(REQUEST_START_HEADER));
    if (Number.isFinite(start) && start > 0 && now >= start) context.durationMs = now - start;
    return context;
  }
  ```
- [ ] **Step 4: Wire the middleware.** In `src/middleware.ts`:
  - Add below `import { verifySession, SESSION_COOKIE } from '@/lib/auth'`:
    ```ts
    import { stampRequestContext } from '@/lib/observability/request-context'
    ```
  - Add above `export async function middleware`:
    ```ts
    // Pass-through carrying request-scoped observability headers (spec 007) — always set here, so a
    // client can never forge them; handleApiError reads them for the log line and the Sentry tags.
    function pass(request: NextRequest): NextResponse {
      return NextResponse.next({
        request: { headers: stampRequestContext(request.headers, request.nextUrl.pathname) },
      })
    }
    ```
  - Replace each of the three `return NextResponse.next()` with `return pass(request)` (public API branch, public page branch, final authenticated return). Redirects and the 401 JSON stay as they are.
  - Replace the `config` export with:
    ```ts
    export const config = {
      // monitoring = Sentry's same-origin tunnel (spec 007): it must reach its rewrite without the auth
      // gate, so pages viewed while logged out (login, register) can report too.
      matcher: ['/((?!monitoring|_next/static|_next/image|favicon.ico|favicon.svg|icons|manifest.json|sw.js|workbox-.*).*)']
    }
    ```
- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/lib/observability/request-context.test.ts src/middleware.test.ts` → all pass.
- [ ] **Step 6: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 5: JSON logger with Sentry breadcrumbs (R9)

**Files:**
- Create: `src/lib/logger.ts`
- Test: `src/lib/logger.test.ts`

**Interfaces:**
- Consumes: `redactText` (Task 2).
- Produces (`src/lib/logger.ts`): `export type LogLevel = "info" | "warn" | "error"`; `export type LogValue = string | number | boolean | undefined`; `export interface LogFields { requestId?: string; route?: string; status?: number; durationMs?: number; [key: string]: LogValue }`; `export function log(level: LogLevel, msg: string, fields?: LogFields, error?: unknown): void`; `export const logger: { info(msg, fields?), warn(msg, fields?, error?), error(msg, fields?, error?) }`.

- [ ] **Step 1: Write the failing tests.** Create `src/lib/logger.test.ts`:
  ```ts
  import { describe, it, expect, vi, afterEach } from "vitest";

  const { mockAddBreadcrumb } = vi.hoisted(() => ({ mockAddBreadcrumb: vi.fn() }));
  vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: mockAddBreadcrumb }));

  import { logger } from "./logger";

  afterEach(() => {
    vi.restoreAllMocks();
    mockAddBreadcrumb.mockReset();
  });

  const lineOf = (spy: { mock: { calls: unknown[][] } }) => JSON.parse(spy.mock.calls[0][0] as string);

  describe("logger (R9)", () => {
    it("writes exactly one JSON line to stdout for info, omitting undefined fields", () => {
      const out = vi.spyOn(console, "log").mockImplementation(() => {});
      logger.info("cache warmed", { route: "/api/health", status: 200, durationMs: 12, requestId: undefined });
      expect(out).toHaveBeenCalledTimes(1);
      const line = lineOf(out);
      expect(line).toEqual({ time: expect.any(String), level: "info", msg: "cache warmed", route: "/api/health", status: 200, durationMs: 12 });
      expect(Number.isNaN(Date.parse(line.time))).toBe(false);
    });

    it("sends warn to console.warn and error to console.error with the serialized, redacted error", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.warn("slow query", { route: "/api/expenses", durationMs: 900 });
      logger.error("Failed to create expense", { requestId: "req-1", status: 500 }, new TypeError("bad value for ana@example.com"));
      expect(lineOf(warn)).toMatchObject({ level: "warn", msg: "slow query", durationMs: 900 });
      const line = lineOf(err);
      expect(line).toMatchObject({ level: "error", msg: "Failed to create expense", requestId: "req-1", status: 500 });
      expect(line.error).toMatchObject({ name: "TypeError", message: "bad value for [email]" });
      expect(line.error.stack).toContain("TypeError: bad value for [email]");
    });

    it("serializes non-Error values", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.error("audit log failed", {}, "plain failure for ana@example.com");
      expect(lineOf(err).error).toEqual({ message: "plain failure for [email]" });
    });

    it("adds a Sentry breadcrumb with the same message and fields", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      logger.warn("slow query", { route: "/api/expenses", durationMs: 900, requestId: undefined });
      expect(mockAddBreadcrumb).toHaveBeenCalledWith({
        category: "log",
        level: "warning",
        message: "slow query",
        data: { route: "/api/expenses", durationMs: 900 },
      });
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/logger.test.ts` → FAIL (`Cannot find module './logger'`).
- [ ] **Step 3: Implement.** Create `src/lib/logger.ts`:
  ```ts
  import { addBreadcrumb } from "@sentry/nextjs";
  import { redactText } from "@/lib/observability/scrub";

  // Server logging (spec 007): one JSON line per call — Vercel keeps the stream per level (stdout vs
  // stderr) and log drains parse the JSON — plus a Sentry breadcrumb, so the next captured error in the
  // same request carries the trail. The only console sink in src/ (enforced by logger.test.ts).

  export type LogLevel = "info" | "warn" | "error";
  export type LogValue = string | number | boolean | undefined;

  export interface LogFields {
    requestId?: string;
    route?: string;
    status?: number;
    durationMs?: number;
    [key: string]: LogValue;
  }

  interface SerializedError {
    name?: string;
    message: string;
    stack?: string;
  }

  const SINKS: Record<LogLevel, (line: string) => void> = {
    info: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };

  function serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
      return { name: error.name, message: redactText(error.message), stack: error.stack ? redactText(error.stack) : undefined };
    }
    return { message: redactText(String(error)) };
  }

  function definedFields(fields: LogFields): Record<string, string | number | boolean> {
    const defined: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) defined[key] = value;
    }
    return defined;
  }

  export function log(level: LogLevel, msg: string, fields: LogFields = {}, error?: unknown): void {
    const data = definedFields(fields);
    const entry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...data,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };
    SINKS[level](JSON.stringify(entry));
    addBreadcrumb({ category: "log", level: level === "warn" ? "warning" : level, message: msg, data });
  }

  export const logger = {
    info: (msg: string, fields?: LogFields) => log("info", msg, fields),
    warn: (msg: string, fields?: LogFields, error?: unknown) => log("warn", msg, fields, error),
    error: (msg: string, fields?: LogFields, error?: unknown) => log("error", msg, fields, error),
  };
  ```
- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/logger.test.ts` → all pass.
- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 6: Observability context — opaque user/house and `captureServerError` (R6, R8)

**Files:**
- Create: `src/lib/observability/context.ts`
- Test: `src/lib/observability/context.test.ts`

**Interfaces:**
- Produces (`context.ts`, isomorphic — used by server and browser): `export interface ServerErrorContext { route?: string; status: number; code?: string; requestId?: string }`; `export function setObservedUser(publicId: string | null): void`; `export function setObservedHouse(publicId: string | null): void`; `export function captureServerError(error: unknown, context: ServerErrorContext): string | undefined` (event id, or `undefined` when the SDK is not initialized).

- [ ] **Step 1: Write the failing tests.** Create `src/lib/observability/context.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";

  const { sentry } = vi.hoisted(() => ({
    sentry: { getClient: vi.fn(), captureException: vi.fn(), setUser: vi.fn(), setTag: vi.fn() },
  }));
  vi.mock("@sentry/nextjs", () => sentry);

  import { captureServerError, setObservedHouse, setObservedUser } from "./context";

  const USER_ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
  const HOUSE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("observed identity (R8)", () => {
    it("sets only the opaque user id, and clears it", () => {
      setObservedUser(USER_ID);
      setObservedUser(null);
      expect(sentry.setUser.mock.calls).toEqual([[{ id: USER_ID }], [null]]);
    });

    it("tags the house with its publicId, and clears it", () => {
      setObservedHouse(HOUSE_ID);
      setObservedHouse(null);
      expect(sentry.setTag.mock.calls).toEqual([["house", HOUSE_ID], ["house", undefined]]);
    });
  });

  describe("captureServerError (R6)", () => {
    it("captures once with the dashboard tags and returns the event id", () => {
      sentry.getClient.mockReturnValue({});
      sentry.captureException.mockReturnValue("evt-1");
      const error = new Error("boom");
      expect(captureServerError(error, { route: "/api/expenses/:id", status: 503, code: "UPSTREAM_DOWN", requestId: "req-1" })).toBe("evt-1");
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        tags: { http_status: "503", route: "/api/expenses/:id", api_error_code: "UPSTREAM_DOWN", request_id: "req-1" },
      });
    });

    it("omits absent tags", () => {
      sentry.getClient.mockReturnValue({});
      captureServerError(new Error("x"), { status: 500 });
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { http_status: "500" } });
    });

    it("does nothing and returns undefined while the SDK is not initialized", () => {
      sentry.getClient.mockReturnValue(undefined);
      expect(captureServerError(new Error("x"), { status: 500 })).toBeUndefined();
      expect(sentry.captureException).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/observability/context.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.** Create `src/lib/observability/context.ts`:
  ```ts
  import * as Sentry from "@sentry/nextjs";

  // What Sentry may know about who/where (spec 007, LGPD): opaque publicIds only — never names,
  // e-mails or amounts. Without an initialized SDK every call is a no-op.

  export interface ServerErrorContext {
    route?: string;
    status: number;
    code?: string;
    requestId?: string;
  }

  /** The signed-in member as Sentry's user — their publicId (UUID) and nothing else. */
  export function setObservedUser(publicId: string | null): void {
    Sentry.setUser(publicId ? { id: publicId } : null);
  }

  /** Tags events with the active house's publicId (never its name). */
  export function setObservedHouse(publicId: string | null): void {
    Sentry.setTag("house", publicId ?? undefined);
  }

  /** Reports a server failure once, tagged for the dashboard; returns the event id when the SDK is on. */
  export function captureServerError(error: unknown, context: ServerErrorContext): string | undefined {
    if (!Sentry.getClient()) return undefined;
    const tags: Record<string, string> = { http_status: String(context.status) };
    if (context.route) tags.route = context.route;
    if (context.code) tags.api_error_code = context.code;
    if (context.requestId) tags.request_id = context.requestId;
    return Sentry.captureException(error, { tags });
  }
  ```
- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/observability/context.test.ts` → all pass.
- [ ] **Step 5: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 7: Wire `handleApiError`, session/house context, and replace ad-hoc `console.error` (R6, R7, R8, R10)

**Files:**
- Modify: `src/lib/api-helpers.ts` (`recordActivity`, `handleApiError`, `requireSession`, `requireActiveGroup`)
- Create: `src/lib/api-helpers.observability.test.ts`
- Modify: `src/lib/prisma-audit.ts` (two catches), `src/services/shopping-item.service.ts` (`togglePurchased` audit catch)
- Modify: `src/lib/logger.test.ts` (append the static scan)

**Interfaces:**
- Consumes: `logger` (Task 5), `captureServerError` / `setObservedUser` / `setObservedHouse` (Task 6), `readRequestContext` / `RequestContext` (Task 4).
- Produces: `export async function handleApiError(error: unknown, defaultMsg: string): Promise<NextResponse>` (was sync; every caller already does `return handleApiError(...)` inside an async route handler — no call-site change). `requireActiveGroup`'s membership query selects `group: { select: { publicId: true } }`; `GroupCheck` is unchanged.

- [ ] **Step 1: Write the failing tests.** Create `src/lib/api-helpers.observability.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
  import { ApiError } from "@/lib/errors";

  const { sentry, mockHeaders, mockCookies, mockPrisma, mockVerifySession } = vi.hoisted(() => ({
    sentry: { getClient: vi.fn(), captureException: vi.fn(), addBreadcrumb: vi.fn(), setUser: vi.fn(), setTag: vi.fn() },
    mockHeaders: vi.fn(),
    mockCookies: vi.fn(),
    mockPrisma: { user: { findUnique: vi.fn() }, groupMember: { findMany: vi.fn() } },
    mockVerifySession: vi.fn(),
  }));
  vi.mock("@sentry/nextjs", () => sentry);
  vi.mock("next/headers", () => ({ headers: mockHeaders, cookies: mockCookies }));
  vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
  vi.mock("@/lib/auth", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/auth")>();
    return { ...actual, verifySession: mockVerifySession };
  });

  import { handleApiError, requireActiveGroup, requireSession } from "./api-helpers";

  const USER_ID = "3f2b8c1e-5a6d-4e7f-9a0b-1c2d3e4f5a6b";
  const HOUSE_ID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
  const EXPENSE_PATH = "/api/expenses/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc";

  let consoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetAllMocks();
    sentry.getClient.mockReturnValue({});
    sentry.captureException.mockReturnValue("evt-1");
    mockHeaders.mockResolvedValue(
      new Headers({
        "x-homeshare-request-id": "req-1",
        "x-homeshare-path": EXPENSE_PATH,
        "x-homeshare-start": String(Date.now() - 25),
      })
    );
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const logLine = () => JSON.parse(consoleError.mock.calls[0][0] as string);

  function signedIn() {
    mockCookies.mockResolvedValue({
      get: (name: string) =>
        name === "homeshare_session" ? { value: "token" } : name === "homeshare_group" ? { value: "7" } : undefined,
    });
    mockVerifySession.mockResolvedValue({ userId: 1, publicId: USER_ID, name: "Ana", sessionVersion: 2, iat: 0 });
    mockPrisma.user.findUnique.mockResolvedValue({ sessionVersion: 2 });
  }

  describe("handleApiError — what reaches Sentry (spec 007)", () => {
    it("captures an unexpected error once, logs one JSON line, and answers the same generic 500 (R6)", async () => {
      const error = new Error("boom for ana@example.com");
      const response = await handleApiError(error, "Failed to load expense");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Failed to load expense" });
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
      expect(sentry.captureException).toHaveBeenCalledWith(error, {
        tags: { http_status: "500", route: "/api/expenses/:id", request_id: "req-1" },
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
      const line = logLine();
      expect(line).toMatchObject({
        level: "error",
        msg: "Failed to load expense",
        requestId: "req-1",
        route: "/api/expenses/:id",
        status: 500,
        sentryEventId: "evt-1",
      });
      expect(line.durationMs).toBeGreaterThanOrEqual(25);
      expect(line.error.message).toBe("boom for [email]");
    });

    it("answers an expected 4xx ApiError as before and reports nothing (R7)", async () => {
      const response = await handleApiError(new ApiError("Expense not found", 404, "EXPENSE_NOT_FOUND"), "Failed to load expense");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Expense not found", code: "EXPENSE_NOT_FOUND" });
      expect(sentry.captureException).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(mockHeaders).not.toHaveBeenCalled();
    });

    it("captures a 5xx ApiError with its code and keeps its own message (R6)", async () => {
      const response = await handleApiError(new ApiError("Upstream unavailable", 503, "UPSTREAM_DOWN"), "Failed to sync");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Upstream unavailable", code: "UPSTREAM_DOWN" });
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(ApiError), {
        tags: { http_status: "503", route: "/api/expenses/:id", api_error_code: "UPSTREAM_DOWN", request_id: "req-1" },
      });
      expect(logLine()).toMatchObject({ status: 503, code: "UPSTREAM_DOWN" });
    });

    it("still answers and captures outside a request scope (no headers)", async () => {
      mockHeaders.mockRejectedValue(new Error("headers() outside a request"));
      const response = await handleApiError(new Error("boom"), "Failed");
      expect(response.status).toBe(500);
      expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { tags: { http_status: "500" } });
    });

    it("logs without an event id while the SDK is off", async () => {
      sentry.getClient.mockReturnValue(undefined);
      await handleApiError(new Error("boom"), "Failed");
      expect(sentry.captureException).not.toHaveBeenCalled();
      expect(logLine()).not.toHaveProperty("sentryEventId");
    });
  });

  describe("request identity (R8)", () => {
    it("requireSession sets the Sentry user to the member's publicId only", async () => {
      signedIn();
      const check = await requireSession();
      expect(check.ok).toBe(true);
      expect(sentry.setUser).toHaveBeenCalledWith({ id: USER_ID });
    });

    it("requireActiveGroup tags the house with its publicId", async () => {
      signedIn();
      mockPrisma.groupMember.findMany.mockResolvedValue([{ groupId: 7, role: "ADMIN", group: { publicId: HOUSE_ID } }]);
      const check = await requireActiveGroup();
      expect(check).toMatchObject({ ok: true, groupId: 7, role: "ADMIN" });
      expect(sentry.setTag).toHaveBeenCalledWith("house", HOUSE_ID);
      expect(mockPrisma.groupMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: { groupId: true, role: true, group: { select: { publicId: true } } } })
      );
    });
  });
  ```
  Append to `src/lib/logger.test.ts`:
  ```ts
  import { readdirSync, readFileSync } from "node:fs";
  import path from "node:path";

  describe("the logger is the only console sink in src/ (R10)", () => {
    it("has no ad-hoc console.log/warn/error outside src/lib/logger.ts", () => {
      const src = path.join(process.cwd(), "src");
      const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("generated/"))
        .filter((file) => file !== "lib/logger.ts")
        .filter((file) => /console\.(log|warn|error)\(/.test(readFileSync(path.join(src, file), "utf8")));
      expect(offenders).toEqual([]);
    });
  });
  ```
  (Move the two new `import` lines to the top of `src/lib/logger.test.ts`, next to the existing imports.)
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/lib/api-helpers.observability.test.ts src/lib/logger.test.ts` → FAIL (no capture/setUser/setTag yet; the scan lists `lib/api-helpers.ts`, `lib/prisma-audit.ts`, `services/shopping-item.service.ts`).
- [ ] **Step 3: Implement in `src/lib/api-helpers.ts`.**
  - Replace `import { cookies } from 'next/headers'` with `import { cookies, headers } from 'next/headers'`, and add below `import { paymentMethodService } from '@/services/payment-method.service'`:
    ```ts
    import { logger } from '@/lib/logger'
    import { captureServerError, setObservedHouse, setObservedUser } from '@/lib/observability/context'
    import { readRequestContext, type RequestContext } from '@/lib/observability/request-context'
    ```
  - In `recordActivity`, replace `console.error('audit log failed', e)` with:
    ```ts
    logger.error('audit log failed', { entityType: entry.entityType }, e)
    ```
  - Replace the whole `handleApiError` function with:
    ```ts
    /** Request-scoped context stamped by the middleware (spec 007); empty outside a request (tests, scripts). */
    async function currentRequestContext(): Promise<RequestContext> {
      try {
        return readRequestContext(await headers())
      } catch {
        return {}
      }
    }

    function apiErrorResponse(error: ApiError): NextResponse {
      return NextResponse.json(
        error.code ? { error: error.message, code: error.code } : { error: error.message },
        { status: error.status }
      )
    }

    export async function handleApiError(error: unknown, defaultMsg: string): Promise<NextResponse> {
      // Expected, typed 4xx failures (not-found, invalid input) are normal operation: answered with their
      // own status/code and never reported (spec 007 — they are not defects).
      if (error instanceof ApiError && error.status < 500) {
        return apiErrorResponse(error)
      }
      // Server failures: one Sentry event (no-op without a DSN) + one JSON log line, correlated by requestId.
      const status = error instanceof ApiError ? error.status : 500
      const code = error instanceof ApiError ? error.code : undefined
      const context = await currentRequestContext()
      const sentryEventId = captureServerError(error, { route: context.route, requestId: context.requestId, status, code })
      logger.error(defaultMsg, { ...context, status, code, sentryEventId }, error)
      if (error instanceof ApiError) return apiErrorResponse(error)
      // Unexpected: generic message so we never leak stack traces, file paths, or DB internals.
      return NextResponse.json({ error: defaultMsg }, { status: 500 })
    }
    ```
  - In `requireSession`, replace
    ```ts
      // Best-effort: stamp the audit actor for writes in this request.
      setAuditContext({ actorId: session.userId })
      return { ok: true, session }
    ```
    with
    ```ts
      // Best-effort: stamp the audit actor for writes in this request.
      setAuditContext({ actorId: session.userId })
      // Observability (spec 007): the opaque publicId is the only user data Sentry ever gets.
      setObservedUser(session.publicId)
      return { ok: true, session }
    ```
  - In `requireActiveGroup`, replace `select: { groupId: true, role: true },` with `select: { groupId: true, role: true, group: { select: { publicId: true } } },`, and replace
    ```ts
      setAuditContext({ groupId: active.groupId })
    ```
    with
    ```ts
      setAuditContext({ groupId: active.groupId })
      setObservedHouse(active.group.publicId)
    ```
- [ ] **Step 4: Replace the remaining ad-hoc console calls.**
  - `src/lib/prisma-audit.ts`: add `import { logger } from "@/lib/logger";` below `import { verifySession, SESSION_COOKIE } from "@/lib/auth";`; replace `.catch((e) => console.error("audit revision failed", e));` with `.catch((e) => logger.error("audit revision failed", { entityType: rows[0].entityType }, e));` and `console.error("audit post-write failed", e);` with `logger.error("audit post-write failed", { entityType: model, operation }, e);`.
  - `src/services/shopping-item.service.ts`: add `import { logger } from '@/lib/logger'` below `import { sanitize } from '@/lib/prisma-audit'`; in `togglePurchased` replace `console.error('audit revision failed', e)` with `logger.error('audit revision failed', { entityType: 'ShoppingItem' }, e)`.
- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/lib/api-helpers.observability.test.ts src/lib/logger.test.ts src/lib/api-helpers.session.test.ts src/app/api/groups/active/members` → all pass.
- [ ] **Step 6: Gates.** `npm run test` (the full suite now loads the real `@sentry/nextjs` through `api-helpers`; every test must still pass), `npx tsc --noEmit`, `npx eslint src`.

---

### Task 8: SDK entry points + DSN-gated `withSentryConfig` (R1, R2, R12, R14)

**Files:**
- Create: `src/instrumentation.ts`, `src/instrumentation-client.ts`
- Create: `src/instrumentation.test.ts`
- Modify: `next.config.ts`
- Create: `src/lib/observability/next-config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `initSentry` (Task 3).
- Produces: Next instrumentation exports `register()`, `onRequestError` (`= Sentry.captureRequestError`), client `onRouterTransitionStart` (`= Sentry.captureRouterTransitionStart`). Env vars read: server `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `VERCEL_ENV`; browser `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_VERCEL_ENV`; build `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`, `CI`.

- [ ] **Step 1: Write the failing tests.** Create `src/instrumentation.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

  const { sentry } = vi.hoisted(() => ({
    sentry: { init: vi.fn(), captureRequestError: vi.fn(), captureRouterTransitionStart: vi.fn() },
  }));
  vi.mock("@sentry/nextjs", () => sentry);

  const DSN = "https://k@o1.ingest.sentry.io/2";

  beforeEach(() => {
    vi.resetModules();
    sentry.init.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("server/edge instrumentation (R1)", () => {
    it("does not initialize the SDK without SENTRY_DSN", async () => {
      vi.stubEnv("SENTRY_DSN", "");
      const { register } = await import("./instrumentation");
      register();
      expect(sentry.init).not.toHaveBeenCalled();
    });

    it("initializes from SENTRY_DSN / SENTRY_TRACES_SAMPLE_RATE / VERCEL_ENV and exposes onRequestError", async () => {
      vi.stubEnv("SENTRY_DSN", DSN);
      vi.stubEnv("VERCEL_ENV", "production");
      vi.stubEnv("SENTRY_TRACES_SAMPLE_RATE", "0.5");
      const instrumentation = await import("./instrumentation");
      instrumentation.register();
      expect(sentry.init).toHaveBeenCalledTimes(1);
      expect(sentry.init.mock.calls[0][0]).toMatchObject({ dsn: DSN, environment: "production", tracesSampleRate: 0.5 });
      expect(instrumentation.onRequestError).toBe(sentry.captureRequestError);
    });
  });

  describe("browser instrumentation (R1)", () => {
    it("does not initialize the SDK without NEXT_PUBLIC_SENTRY_DSN", async () => {
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
      await import("./instrumentation-client");
      expect(sentry.init).not.toHaveBeenCalled();
    });

    it("initializes from the NEXT_PUBLIC_* variables and exposes onRouterTransitionStart", async () => {
      vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
      vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
      vi.stubEnv("NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "");
      const client = await import("./instrumentation-client");
      expect(sentry.init).toHaveBeenCalledTimes(1);
      expect(sentry.init.mock.calls[0][0]).toMatchObject({ dsn: DSN, environment: "preview", tracesSampleRate: 1 });
      expect(client.onRouterTransitionStart).toBe(sentry.captureRouterTransitionStart);
    });
  });
  ```
  Create `src/lib/observability/next-config.test.ts`:
  ```ts
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

  const { mockWithSentryConfig } = vi.hoisted(() => ({
    mockWithSentryConfig: vi.fn((config: object, options: object) => ({ ...config, sentryOptions: options })),
  }));
  vi.mock("@sentry/nextjs/config", () => ({ withSentryConfig: mockWithSentryConfig }));
  vi.mock("next-intl/plugin", () => ({ default: () => (config: object) => config }));

  const DSN = "https://k@o1.ingest.sentry.io/2";
  const SENTRY_BUILD_VARS = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

  type LoadedConfig = Record<string, unknown> & {
    sentryOptions?: Record<string, unknown>;
    headers?: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
  };

  async function loadConfig(env: Record<string, string>): Promise<LoadedConfig> {
    for (const name of SENTRY_BUILD_VARS) vi.stubEnv(name, env[name] ?? "");
    vi.resetModules();
    return (await import("../../../next.config")).default as unknown as LoadedConfig;
  }

  beforeEach(() => {
    mockWithSentryConfig.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("next.config Sentry gate (R2, R12)", () => {
    it("exports the config untouched without a DSN", async () => {
      const config = await loadConfig({});
      expect(mockWithSentryConfig).not.toHaveBeenCalled();
      expect(config).not.toHaveProperty("sentryOptions");
      expect(typeof config.headers).toBe("function");
    });

    it("wraps with the same-origin tunnel and no source-map upload when there is no auth token", async () => {
      const config = await loadConfig({ NEXT_PUBLIC_SENTRY_DSN: DSN });
      expect(mockWithSentryConfig).toHaveBeenCalledTimes(1);
      expect(config.sentryOptions).toMatchObject({ tunnelRoute: "/monitoring", telemetry: false, sourcemaps: { disable: true } });
    });

    it("enables source-map upload only when SENTRY_AUTH_TOKEN exists", async () => {
      const config = await loadConfig({ SENTRY_DSN: DSN, SENTRY_AUTH_TOKEN: "sntrys_test", SENTRY_ORG: "acme", SENTRY_PROJECT: "home-share" });
      expect(config.sentryOptions).toMatchObject({
        org: "acme",
        project: "home-share",
        authToken: "sntrys_test",
        sourcemaps: { disable: false },
      });
    });

    it("keeps the production CSP connect-src same-origin", async () => {
      const config = await loadConfig({ NEXT_PUBLIC_SENTRY_DSN: DSN });
      vi.stubEnv("NODE_ENV", "production");
      const [rule] = await config.headers!();
      const csp = rule.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("sentry.io");
    });
  });
  ```
- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/instrumentation.test.ts src/lib/observability/next-config.test.ts` → FAIL (instrumentation files missing; `withSentryConfig` never called).
- [ ] **Step 3: Create the entry points.** `src/instrumentation.ts`:
  ```ts
  import * as Sentry from "@sentry/nextjs";
  import { initSentry } from "@/lib/observability/init";

  // Server + edge SDK init (spec 007). Without SENTRY_DSN, initSentry is a no-op and nothing is sent.
  export function register(): void {
    initSentry({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
    });
  }

  // Uncaught errors from server components, route handlers and middleware. Route handlers that catch
  // through handleApiError report there instead (exactly once).
  export const onRequestError = Sentry.captureRequestError;
  ```
  `src/instrumentation-client.ts`:
  ```ts
  import * as Sentry from "@sentry/nextjs";
  import { initSentry } from "@/lib/observability/init";

  // Browser SDK init (spec 007). NEXT_PUBLIC_* values are inlined at build time; without
  // NEXT_PUBLIC_SENTRY_DSN nothing is initialized and nothing is sent.
  initSentry({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  });

  // Navigation spans for App Router transitions.
  export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
  ```
- [ ] **Step 4: Gate the build wrapper in `next.config.ts`.**
  - Add below `import createNextIntlPlugin from "next-intl/plugin";`:
    ```ts
    import { withSentryConfig } from "@sentry/nextjs/config";
    ```
  - Replace `export default withNextIntl(nextConfig);` with:
    ```ts
    const config = withNextIntl(nextConfig);

    // Observability (spec 007, ADR 0008): Sentry wraps the build ONLY when a DSN is configured, so a
    // build without Sentry env vars is exactly the config above. Source maps are uploaded only when
    // SENTRY_AUTH_TOKEN exists (the build never requires it). Browser envelopes go through the
    // same-origin tunnel /monitoring, so the CSP keeps connect-src 'self' and ad-blockers can't drop them.
    const sentryDsn = (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "").trim();

    export default sentryDsn
      ? withSentryConfig(config, {
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
          tunnelRoute: "/monitoring",
          telemetry: false,
          silent: !process.env.CI,
        })
      : config;
    ```
- [ ] **Step 5: Document the variables in `.env.example`** (the committed template without secrets — reading it is fine; `.env` / `.env.local` stay off-limits). Append, names only, no values:
  ```bash
  # Sentry (observabilidade, spec 007). Vazio = desligado: o SDK não inicializa e o build não muda.
  SENTRY_DSN=
  NEXT_PUBLIC_SENTRY_DSN=
  # Opcional: amostragem de traces (0–1). Padrão: 0.1 em produção, 1.0 nos demais ambientes.
  SENTRY_TRACES_SAMPLE_RATE=
  NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=
  # Só no build da Vercel, para enviar source maps. Nunca commitar valores.
  SENTRY_ORG=
  SENTRY_PROJECT=
  SENTRY_AUTH_TOKEN=
  ```
- [ ] **Step 6: Run to verify they pass.** `npx vitest run src/instrumentation.test.ts src/lib/observability/next-config.test.ts` → all pass.
- [ ] **Step 7: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 9: Localized GlobalError screen + client user/house context (R8, R13)

**Files:**
- Create: `src/lib/locale-cookie.ts` · Test: `src/lib/locale-cookie.test.ts`
- Create: `src/app/global-error.tsx`
- Modify: `src/lib/session.tsx` (`SessionProvider`)
- Modify: `src/messages/{en,pt,es,fr}.json` (new `GlobalError` namespace)

**Interfaces:**
- Consumes: `LANGUAGES` (`src/lib/client-preferences.ts`), `setObservedUser` / `setObservedHouse` (Task 6).
- Produces: `export type UiLocale = (typeof LANGUAGES)[number]["code"]`; `export function localeFromCookie(cookieHeader: string): UiLocale`; i18n keys `GlobalError.title`, `GlobalError.description`, `GlobalError.reload`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/locale-cookie.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { localeFromCookie } from "./locale-cookie";

  describe("localeFromCookie (R13)", () => {
    it.each([
      ["locale=pt", "pt"],
      ["homeshare_theme=bolitas; locale=fr", "fr"],
      [" locale=es ; other=1", "es"],
      ["locale=de", "en"],
      ["xlocale=pt", "en"],
      ["", "en"],
    ])("%j → %s", (cookie, expected) => {
      expect(localeFromCookie(cookie)).toBe(expected);
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/locale-cookie.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement the helper.** Create `src/lib/locale-cookie.ts`:
  ```ts
  import { LANGUAGES } from "@/lib/client-preferences";

  export type UiLocale = (typeof LANGUAGES)[number]["code"];

  const CODES: readonly string[] = LANGUAGES.map((language) => language.code);

  /** The `locale` preference cookie when it names a supported UI locale, else "en" (DEFAULT_LOCALE). */
  export function localeFromCookie(cookieHeader: string): UiLocale {
    for (const part of cookieHeader.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === "locale" && value !== undefined && CODES.includes(value)) return value as UiLocale;
    }
    return "en";
  }
  ```
- [ ] **Step 4: Add the messages.** In each `src/messages/*.json`, the `NotFound` block is the last one; replace its closing `  }\n}` so the file ends with a new `GlobalError` block:
  - `en.json` — replace
    ```json
        "back": "Back to expenses"
      }
    }
    ```
    with
    ```json
        "back": "Back to expenses"
      },
      "GlobalError": {
        "title": "Something went wrong",
        "description": "An unexpected error stopped this page. Reloading usually fixes it.",
        "reload": "Reload page"
      }
    }
    ```
  - `pt.json` — after `"back": "Voltar para despesas"` → `"GlobalError": { "title": "Algo deu errado", "description": "Um erro inesperado interrompeu esta página. Recarregar costuma resolver.", "reload": "Recarregar página" }` (same layout as above).
  - `es.json` — after `"back": "Volver a gastos"` → `"GlobalError": { "title": "Algo salió mal", "description": "Un error inesperado detuvo esta página. Recargar suele solucionarlo.", "reload": "Recargar página" }`.
  - `fr.json` — after `"back": "Retour aux dépenses"` → `"GlobalError": { "title": "Une erreur est survenue", "description": "Une erreur inattendue a interrompu cette page. Recharger la page règle généralement le problème.", "reload": "Recharger la page" }`.
  Run the i18n parity check → `i18n parity OK`.
- [ ] **Step 5: Create `src/app/global-error.tsx`:**
  ```tsx
  "use client";

  import * as Sentry from "@sentry/nextjs";
  import { useEffect, useState } from "react";
  import { localeFromCookie, type UiLocale } from "@/lib/locale-cookie";
  import "./globals.css";

  interface GlobalErrorMessages {
    title: string;
    description: string;
    reload: string;
  }

  // global-error replaces the root layout, so there is no NextIntlClientProvider here: it loads only the
  // visitor's locale file, lazily — one chunk per locale, fetched only after the app has crashed.
  const MESSAGES: Record<UiLocale, () => Promise<{ default: { GlobalError: GlobalErrorMessages } }>> = {
    en: () => import("@/messages/en.json"),
    pt: () => import("@/messages/pt.json"),
    es: () => import("@/messages/es.json"),
    fr: () => import("@/messages/fr.json"),
  };

  export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
    const [screen, setScreen] = useState<{ locale: UiLocale; text: GlobalErrorMessages } | null>(null);

    useEffect(() => {
      Sentry.captureException(error);
    }, [error]);

    useEffect(() => {
      let active = true;
      const locale = localeFromCookie(document.cookie);
      MESSAGES[locale]().then((messages) => {
        if (active) setScreen({ locale, text: messages.default.GlobalError });
      });
      return () => {
        active = false;
      };
    }, []);

    return (
      <html lang={screen?.locale ?? "en"}>
        <body className="antialiased">
          <main className="paper-grain flex min-h-dvh flex-col items-center justify-center px-4 py-10 text-center">
            <div className="w-full max-w-sm">
              <p className="font-display text-2xl font-bold tracking-tight text-ink">
                HOME<span className="text-stamp">SHARE</span>
              </p>
              {screen && (
                <>
                  <h1 className="mt-8 font-display text-lg font-bold uppercase tracking-wide text-ink">{screen.text.title}</h1>
                  <p className="mt-2 text-sm text-ink-soft">{screen.text.description}</p>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="mt-8 inline-flex min-h-11 items-center justify-center rounded-md border border-ink bg-ink px-4 py-2.5 font-display text-[0.8rem] font-bold uppercase tracking-wider text-paper transition-all hover:bg-stamp-text hover:border-stamp-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper md:min-h-0"
                  >
                    {screen.text.reload}
                  </button>
                </>
              )}
            </div>
          </main>
        </body>
      </html>
    );
  }
  ```
- [ ] **Step 6: Client identity in `src/lib/session.tsx`.**
  - Add below `import type { Me, MeGroup, Member } from "@/lib/types";`:
    ```ts
    import { setObservedHouse, setObservedUser } from "@/lib/observability/context";
    ```
  - Insert right after the `activeGroup` `useMemo` (before `const activeGroupId = activeGroup?.id ?? null;`):
    ```ts
    // Observability (spec 007): the browser SDK gets the same opaque ids as the server — never names.
    const userPublicId = me?.user.publicId ?? null;
    const housePublicId = activeGroup?.publicId ?? null;
    useEffect(() => {
      setObservedUser(userPublicId);
    }, [userPublicId]);
    useEffect(() => {
      setObservedHouse(housePublicId);
    }, [housePublicId]);
    ```
- [ ] **Step 7: Run to verify.** `npx vitest run src/lib/locale-cookie.test.ts` → all pass; i18n parity → `i18n parity OK`.
- [ ] **Step 8: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 10: Dashboard as code + sync script (R15)

**Files:**
- Create: `docs/observability/sentry-dashboard.json`
- Create: `scripts/sentry-dashboard.mjs`
- Test: `src/lib/observability/dashboard.test.ts`

**Interfaces:**
- Produces: dashboard titled `Home Share — System health` (the script's idempotency key). Script CLI: `node scripts/sentry-dashboard.mjs [--dry-run]`; env (only `process.env`): `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, optional `SENTRY_URL` (default `https://sentry.io`). API calls: `GET /api/0/projects/{org}/{project}/`, `GET /api/0/organizations/{org}/dashboards/?query=<title>&per_page=100`, then `PUT /api/0/organizations/{org}/dashboards/{id}/` or `POST /api/0/organizations/{org}/dashboards/`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/observability/dashboard.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import path from "node:path";

  interface Query { fields: string[]; aggregates: string[]; columns: string[]; conditions: string; orderby: string }
  interface Widget {
    title: string;
    displayType: string;
    widgetType: string;
    queries: Query[];
    layout: { x: number; y: number; w: number; h: number };
  }

  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const dashboard = JSON.parse(read("docs/observability/sentry-dashboard.json")) as { title: string; widgets: Widget[] };
  const script = read("scripts/sentry-dashboard.mjs");

  const WIDGET_TYPES = new Set(["error-events", "spans", "metrics"]);
  const DISPLAY_TYPES = new Set(["line", "area", "bar", "table", "big_number"]);
  const q = (widget: Widget) => widget.queries[0];

  describe("Sentry dashboard definition (R15)", () => {
    it("has the idempotency title and only valid widgets on the 6-column grid", () => {
      expect(dashboard.title).toBe("Home Share — System health");
      for (const widget of dashboard.widgets) {
        expect(WIDGET_TYPES.has(widget.widgetType), widget.title).toBe(true);
        expect(DISPLAY_TYPES.has(widget.displayType), widget.title).toBe(true);
        expect(widget.queries.length, widget.title).toBeGreaterThan(0);
        for (const query of widget.queries) {
          expect(query.aggregates.length, widget.title).toBeGreaterThan(0);
          for (const name of [...query.aggregates, ...query.columns]) expect(query.fields, widget.title).toContain(name);
        }
        expect(widget.layout.x + widget.layout.w, widget.title).toBeLessThanOrEqual(6);
      }
    });

    it.each<[string, (widget: Widget) => boolean]>([
      ["errors by route", (w) => w.widgetType === "error-events" && q(w).columns.includes("route")],
      ["top error codes on 5xx", (w) => w.widgetType === "error-events" && q(w).columns.includes("api_error_code") && q(w).conditions.includes("http_status:5*")],
      ["p95 latency by route", (w) => w.widgetType === "spans" && q(w).aggregates.includes("p95(span.duration)") && q(w).columns.includes("transaction") && q(w).conditions.includes("span.op:http.server")],
      ["DB query p95", (w) => w.widgetType === "spans" && q(w).aggregates.includes("p95(span.duration)") && q(w).conditions.includes("span.category:db")],
      ["LCP", (w) => q(w).aggregates.includes("p75(measurements.lcp)")],
      ["INP", (w) => q(w).aggregates.includes("p75(measurements.inp)")],
      ["CLS", (w) => q(w).aggregates.includes("p75(measurements.cls)")],
      ["crash-free sessions/users", (w) => w.widgetType === "metrics" && q(w).aggregates.includes("crash_free_rate(session)") && q(w).aggregates.includes("crash_free_rate(user)")],
      ["transactions per minute", (w) => w.widgetType === "spans" && q(w).aggregates.includes("epm()") && q(w).conditions.includes("is_transaction:true")],
    ])("covers %s", (_name, predicate) => {
      expect(dashboard.widgets.some(predicate)).toBe(true);
    });

    it("the sync script takes credentials only from process.env — never env files", () => {
      expect(script).not.toMatch(/dotenv/);
      expect(script).not.toMatch(/["'`][^"'`\n]*\.env[^"'`\n]*["'`]/);
      for (const name of ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"]) expect(script).toContain(name);
      expect(script).toContain("--dry-run");
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/observability/dashboard.test.ts` → FAIL (`ENOENT … sentry-dashboard.json`).
- [ ] **Step 3: Create `docs/observability/sentry-dashboard.json`:**
  ```json
  {
    "title": "Home Share — System health",
    "period": "7d",
    "environment": ["production"],
    "filters": {},
    "widgets": [
      {
        "title": "Transactions per minute",
        "description": "Root spans per minute by kind: http.server = API/page requests; pageload/navigation = browser.",
        "displayType": "line",
        "widgetType": "spans",
        "interval": "1h",
        "limit": 5,
        "queries": [
          {
            "name": "",
            "fields": ["span.op", "epm()"],
            "aggregates": ["epm()"],
            "columns": ["span.op"],
            "fieldAliases": [],
            "conditions": "is_transaction:true",
            "orderby": "-epm()"
          }
        ],
        "layout": { "x": 0, "y": 0, "w": 4, "h": 2, "minH": 2 }
      },
      {
        "title": "Crash-free sessions and users",
        "description": "Release health. SDK v11 records browser sessions hit by an uncaught error as 'unhandled', not 'crashed' — read together with the error widgets.",
        "displayType": "line",
        "widgetType": "metrics",
        "interval": "1h",
        "queries": [
          {
            "name": "",
            "fields": ["crash_free_rate(session)", "crash_free_rate(user)"],
            "aggregates": ["crash_free_rate(session)", "crash_free_rate(user)"],
            "columns": [],
            "fieldAliases": [],
            "conditions": "",
            "orderby": ""
          }
        ],
        "layout": { "x": 4, "y": 0, "w": 2, "h": 2, "minH": 2 }
      },
      {
        "title": "Errors by route",
        "description": "route = server tag from handleApiError (normalized path); transaction = SDK route name (client and uncaught errors).",
        "displayType": "table",
        "widgetType": "error-events",
        "interval": "1h",
        "limit": 10,
        "queries": [
          {
            "name": "",
            "fields": ["route", "transaction", "count()", "count_unique(user)"],
            "aggregates": ["count()", "count_unique(user)"],
            "columns": ["route", "transaction"],
            "fieldAliases": [],
            "conditions": "event.type:error",
            "orderby": "-count()"
          }
        ],
        "layout": { "x": 0, "y": 2, "w": 3, "h": 3, "minH": 2 }
      },
      {
        "title": "Top error codes on 5xx",
        "description": "ApiError code when the failure carried one, otherwise the exception type.",
        "displayType": "table",
        "widgetType": "error-events",
        "interval": "1h",
        "limit": 10,
        "queries": [
          {
            "name": "",
            "fields": ["api_error_code", "error.type", "count()"],
            "aggregates": ["count()"],
            "columns": ["api_error_code", "error.type"],
            "fieldAliases": [],
            "conditions": "http_status:5*",
            "orderby": "-count()"
          }
        ],
        "layout": { "x": 3, "y": 2, "w": 3, "h": 3, "minH": 2 }
      },
      {
        "title": "p95 latency by route",
        "description": "Server root spans (API routes and server-rendered pages).",
        "displayType": "table",
        "widgetType": "spans",
        "interval": "1h",
        "limit": 10,
        "queries": [
          {
            "name": "",
            "fields": ["transaction", "p95(span.duration)", "count()"],
            "aggregates": ["p95(span.duration)", "count()"],
            "columns": ["transaction"],
            "fieldAliases": [],
            "conditions": "is_transaction:true span.op:http.server",
            "orderby": "-p95(span.duration)"
          }
        ],
        "layout": { "x": 0, "y": 5, "w": 3, "h": 3, "minH": 2 }
      },
      {
        "title": "DB query p95",
        "description": "Prisma/pg spans by statement summary (parameter values are never collected).",
        "displayType": "table",
        "widgetType": "spans",
        "interval": "1h",
        "limit": 10,
        "queries": [
          {
            "name": "",
            "fields": ["span.description", "p95(span.duration)", "count()"],
            "aggregates": ["p95(span.duration)", "count()"],
            "columns": ["span.description"],
            "fieldAliases": [],
            "conditions": "span.category:db",
            "orderby": "-p95(span.duration)"
          }
        ],
        "layout": { "x": 3, "y": 5, "w": 3, "h": 3, "minH": 2 }
      },
      {
        "title": "LCP p75",
        "description": "Largest Contentful Paint (good ≤ 2.5 s).",
        "displayType": "big_number",
        "widgetType": "spans",
        "interval": "1h",
        "queries": [
          {
            "name": "",
            "fields": ["p75(measurements.lcp)"],
            "aggregates": ["p75(measurements.lcp)"],
            "columns": [],
            "fieldAliases": [],
            "conditions": "",
            "orderby": ""
          }
        ],
        "layout": { "x": 0, "y": 8, "w": 2, "h": 2, "minH": 2 }
      },
      {
        "title": "INP p75",
        "description": "Interaction to Next Paint (good ≤ 200 ms).",
        "displayType": "big_number",
        "widgetType": "spans",
        "interval": "1h",
        "queries": [
          {
            "name": "",
            "fields": ["p75(measurements.inp)"],
            "aggregates": ["p75(measurements.inp)"],
            "columns": [],
            "fieldAliases": [],
            "conditions": "",
            "orderby": ""
          }
        ],
        "layout": { "x": 2, "y": 8, "w": 2, "h": 2, "minH": 2 }
      },
      {
        "title": "CLS p75",
        "description": "Cumulative Layout Shift (good ≤ 0.1).",
        "displayType": "big_number",
        "widgetType": "spans",
        "interval": "1h",
        "queries": [
          {
            "name": "",
            "fields": ["p75(measurements.cls)"],
            "aggregates": ["p75(measurements.cls)"],
            "columns": [],
            "fieldAliases": [],
            "conditions": "",
            "orderby": ""
          }
        ],
        "layout": { "x": 4, "y": 8, "w": 2, "h": 2, "minH": 2 }
      }
    ]
  }
  ```
- [ ] **Step 4: Create `scripts/sentry-dashboard.mjs`:**
  ```js
  #!/usr/bin/env node
  // Creates or updates the "Home Share — System health" Sentry dashboard from
  // docs/observability/sentry-dashboard.json (spec 007). Credentials come ONLY from process.env:
  // this script never loads env files, so a token is used only when exported in the current shell.
  //
  //   node scripts/sentry-dashboard.mjs --dry-run   # validate + list widgets; no network, no credentials
  //   node scripts/sentry-dashboard.mjs             # needs SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
  import { readFile } from "node:fs/promises";

  const DEFINITION = new URL("../docs/observability/sentry-dashboard.json", import.meta.url);
  const REQUIRED_ENV = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

  async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const dashboard = JSON.parse(await readFile(DEFINITION, "utf8"));
    console.log(`Dashboard "${dashboard.title}" — ${dashboard.widgets.length} widgets:`);
    for (const widget of dashboard.widgets) console.log(`  - [${widget.widgetType}/${widget.displayType}] ${widget.title}`);
    if (dryRun) return;

    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`Missing ${missing.join(", ")} — export them in this shell first (env files are never read).`);
    }
    const token = process.env.SENTRY_AUTH_TOKEN;
    const org = encodeURIComponent(process.env.SENTRY_ORG);
    const project = encodeURIComponent(process.env.SENTRY_PROJECT);
    const base = (process.env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, "");

    async function api(method, path, body) {
      const response = await fetch(`${base}/api/0${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}: ${text.slice(0, 2000)}`);
      return text ? JSON.parse(text) : null;
    }

    const projectInfo = await api("GET", `/projects/${org}/${project}/`);
    const payload = { ...dashboard, projects: [Number(projectInfo.id)] };
    const listed = await api("GET", `/organizations/${org}/dashboards/?query=${encodeURIComponent(dashboard.title)}&per_page=100`);
    const existing = listed.find((item) => item.title === dashboard.title);
    if (existing) {
      // Widgets sent without ids replace the dashboard's widgets — the JSON is the source of truth.
      await api("PUT", `/organizations/${org}/dashboards/${existing.id}/`, { ...payload, id: existing.id });
      console.log(`Updated dashboard ${existing.id}.`);
    } else {
      const created = await api("POST", `/organizations/${org}/dashboards/`, payload);
      console.log(`Created dashboard ${created.id}.`);
    }
  }

  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
  ```
- [ ] **Step 5: Run to verify.** `npx vitest run src/lib/observability/dashboard.test.ts` → all pass. `node scripts/sentry-dashboard.mjs --dry-run` → prints `Dashboard "Home Share — System health" — 9 widgets:` and 9 widget lines; no network call, no credentials needed.
- [ ] **Step 6: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 11: Owner checklist (PT) + ADR 0008 (R16)

**Files:**
- Create: `docs/observability.md`, `docs/decisions/0008-observability-sentry.md`
- Modify: `docs/decisions/README.md` (index)
- Test: `src/lib/observability/docs.test.ts`

**Interfaces:**
- Produces: the owner guide that names every Sentry env var read by `next.config.ts`, `src/instrumentation.ts`, `src/instrumentation-client.ts` and `scripts/sentry-dashboard.mjs`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/observability/docs.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { readFileSync } from "node:fs";
  import path from "node:path";

  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const CODE_FILES = ["next.config.ts", "src/instrumentation.ts", "src/instrumentation-client.ts", "scripts/sentry-dashboard.mjs"];

  describe("observability docs (R16)", () => {
    it("documents every Sentry env var the code reads", () => {
      const names = new Set(CODE_FILES.flatMap((file) => read(file).match(/\b(?:NEXT_PUBLIC_)?SENTRY_[A-Z_]+\b/g) ?? []));
      const guide = read("docs/observability.md");
      expect(names.size).toBeGreaterThanOrEqual(8);
      for (const name of names) expect(guide, name).toContain(name);
    });

    it("records the decision in ADR 0008 and indexes it", () => {
      expect(read("docs/decisions/0008-observability-sentry.md")).toMatch(/^# Observability via Sentry/);
      expect(read("docs/decisions/README.md")).toContain("0008-observability-sentry.md");
    });
  });
  ```
- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/observability/docs.test.ts` → FAIL (`ENOENT … observability.md`).
- [ ] **Step 3: Create `docs/observability.md`:**
  ````markdown
  # Observabilidade (Sentry)

  Como ligar, conferir e desligar o monitoramento do Home Share. Decisão: [ADR 0008](decisions/0008-observability-sentry.md) ·
  spec: [007](specs/007-observability-sentry/requirements.md).

  ## O que é coletado (e o que não é)

  - **Erros do servidor** (5xx e exceções inesperadas nas rotas `/api/*`), **erros do navegador** (inclusive a tela
    de erro global) e erros não tratados de páginas e do middleware.
  - **Desempenho**: tempo de cada rota (p95), consultas ao banco (Prisma), Web Vitals (LCP, INP, CLS) e sessões sem crash.
  - **Nunca**: cookies (`homeshare_session`, `homeshare_group`), cabeçalhos `Authorization`/`Cookie`, corpo das
    requisições, query strings, e-mails, nomes, valores, IP. O usuário aparece só como `publicId` (UUID) e a casa
    como a tag `house=<publicId>`.
  - Erros esperados (4xx: não encontrado, validação, sem permissão) **não** viram issue.
  - Sem `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` nada é inicializado: o app e o build ficam exatamente como antes.

  ## Checklist do dono (uma vez)

  1. **Criar o projeto**: sentry.io → Projects → Create Project → plataforma **Next.js** → nome `home-share`.
     Copie o **DSN** (Settings → Projects → home-share → Client Keys (DSN)).
  2. **Privacidade do projeto**: Settings → Projects → home-share → Security & Privacy → ligue **Prevent Storing of
     IP Addresses** e mantenha **Data Scrubber** e **Use Default Scrubbers** ligados.
  3. **Token de source maps** (stack traces legíveis): Settings → Developer Settings → **Organization Tokens** →
     Create New Token. Guarde-o só na Vercel (passo 4) — nunca no repositório.
  4. **Variáveis na Vercel** (Project → Settings → Environment Variables; marque **Production** e **Preview**):

     | Variável | Valor | Obrigatória? |
     | --- | --- | --- |
     | `SENTRY_DSN` | o DSN | sim (servidor) |
     | `NEXT_PUBLIC_SENTRY_DSN` | o mesmo DSN | sim (navegador) |
     | `SENTRY_ORG` | slug da organização | para source maps |
     | `SENTRY_PROJECT` | `home-share` | para source maps |
     | `SENTRY_AUTH_TOKEN` | token do passo 3 (marque **Sensitive**) | para source maps |
     | `SENTRY_TRACES_SAMPLE_RATE` | ex. `0.1` | não — padrão 0.1 em produção, 1.0 em preview |
     | `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | ex. `0.1` | não — mesmo padrão, no navegador |

     Confira que **Automatically expose System Environment Variables** está ligado (é o padrão): o ambiente
     (`production`/`preview`) vem de `VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_ENV`.
  5. **Redeploy** (Deployments → ⋯ → Redeploy): variáveis `NEXT_PUBLIC_*` só chegam ao navegador num build novo.
  6. **Dashboard**: crie um **User Auth Token** (User Settings → Personal Tokens) com os escopos `org:read`,
     `org:write` e `project:read`. No PowerShell, na raiz do repositório:

     ```powershell
     node scripts/sentry-dashboard.mjs --dry-run       # confere o JSON, sem rede e sem token
     $env:SENTRY_AUTH_TOKEN = "<token pessoal>"; $env:SENTRY_ORG = "<org>"; $env:SENTRY_PROJECT = "home-share"
     node scripts/sentry-dashboard.mjs                 # cria ou atualiza "Home Share — System health"
     Remove-Item Env:SENTRY_AUTH_TOKEN
     ```

     O script lê só variáveis exportadas na sessão do terminal — nunca arquivos `.env`. `SENTRY_URL` é opcional
     (padrão `https://sentry.io`). Rodar de novo atualiza o mesmo dashboard: os widgets passam a ser os do JSON.
     Para mudar um widget, edite `docs/observability/sentry-dashboard.json` e rode outra vez.
  7. **Alerta (recomendado)**: Alerts → Create Alert → Issues → "A new issue is created" → e-mail para você.

  ## Como conferir (depois do deploy)

  1. Abra o app com o DevTools → Network: aparecem `POST /monitoring?o=…&p=…` com status 200 (túnel same-origin;
     não deve haver requisição direta para `*.sentry.io`).
  2. Sentry → **Explore → Traces**: em alguns minutos surgem spans `GET /api/...` com filhos de banco e spans de
     página com LCP/CLS/INP.
  3. Sentry → **Releases**: aparece o commit do deploy, com sessões.
  4. Quando surgir uma issue, abra o evento e confira: sem cookies, sem corpo, sem query string, sem e-mail;
     `user.id` é um UUID; tags `route`, `http_status`, `request_id`, `house`.
  5. Para achar o log de um erro: copie a tag `request_id` do evento e busque nos logs da Vercel (linhas JSON com
     `requestId`, `route`, `status`, `durationMs`, `sentryEventId`).

  ## Cotas

  O plano gratuito tem cota mensal de erros e de spans. Se encher, baixe `SENTRY_TRACES_SAMPLE_RATE` e
  `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (ex. `0.05`) e faça redeploy.

  ## Desligar

  Remova `SENTRY_DSN` e `NEXT_PUBLIC_SENTRY_DSN` na Vercel e faça redeploy: o SDK não inicializa e o build volta a
  ser o de antes. Revogue os tokens no Sentry se não for religar.

  ## Observações

  - No SDK v11, sessões do navegador afetadas por erro não tratado contam como `unhandled` (não `crashed`), então
    o "crash-free" tende a ficar perto de 100% — leia junto com os widgets de erros.
  - Se um widget ficar sem dados por mais de um dia com tráfego normal, o nome do campo pode ter mudado no Sentry:
    ajuste-o no JSON e rode o script de novo (o erro da API, se houver, sai no terminal).
  - Corpos JSON malformados ainda respondem 500 e vão aparecer como issue (`SyntaxError` em `/api/...`); trocar
    isso por 400 é uma mudança separada.
  ````
- [ ] **Step 4: Create `docs/decisions/0008-observability-sentry.md`:**
  ```markdown
  # Observability via Sentry with privacy-first defaults

  - Status: accepted
  - Date: 2026-10-03

  **Decision:** errors, traces, Web Vitals and release health go to Sentry through `@sentry/nextjs` (exact pin),
  initialized only when a DSN is configured, with every data-collection category set explicitly to the
  restrictive side and tested `scrubEvent` / `scrubSpan` hooks as the last gate; server logs are JSON lines from
  `src/lib/logger.ts`.

  ## Context and Problem Statement

  Unexpected server errors ended as a generic 500 plus a `console.error` kept only in Vercel's short-retention
  runtime logs; client crashes were not recorded; there was no latency, database or Web Vitals view. The app
  holds housemates' personal data (names, e-mails, shared expenses), so whatever observes it must not export that
  data (LGPD). One person runs it on Vercel serverless + Neon.

  ## Decision Drivers

  - Grouped server and client errors with readable stack traces and alerts — without building it.
  - Latency per route, database time and Web Vitals in one dashboard.
  - No personal data leaves the app, and that guarantee is testable.
  - No new always-on infrastructure; works on serverless and keeps the strict CSP.
  - Off by default in local/QA/CI: no env var, no change.

  ## Considered Options

  1. **Sentry (`@sentry/nextjs`)** — ✅ chosen: errors + tracing + Web Vitals + release health in one SDK built for
     the App Router (instrumentation hooks, a tunnel for CSP/ad-blockers, source maps); the free tier fits.
  2. In-app error table (Postgres `ErrorLog` + admin page) — ❌ records failures in the very database that is often
     the failing part, adds writes and storage on Neon, gives no tracing or Web Vitals, and the dashboard would have
     to be built and maintained.
  3. Axiom — ❌ a strong log/event store, but issue grouping, source-mapped stack traces, release health and Web
     Vitals would have to be assembled on top of it.
  4. Grafana Cloud (OpenTelemetry → Tempo/Loki + Faro) — ❌ the most moving parts (exporters, collector, frontend
     agent) for one maintainer on serverless; error tracking is not its core.
  5. Logs only (JSON logs in Vercel) — ❌ short retention (hours to a day, depending on the plan), no grouping or
     alerting, nothing from the browser.

  ## Decision Outcome

  `@sentry/nextjs@11.4.0`. `initSentry` runs only with `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`; `next.config.ts`
  applies `withSentryConfig` only when a DSN exists, uploading source maps only when `SENTRY_AUTH_TOKEN` exists.
  `dataCollection` is fully explicit because v11 removed `sendDefaultPii` and collects cookies, bodies, database
  query data and user info by default. `handleApiError` captures only server failures (non-ApiError or ApiError ≥
  500); expected 4xx ApiErrors are not issues. Identity is opaque `publicId`s. Browser traffic uses the same-origin
  tunnel `/monitoring`, leaving the CSP unchanged. The dashboard is code
  (`docs/observability/sentry-dashboard.json` + `scripts/sentry-dashboard.mjs`).

  ### Consequences

  - Good: errors, latency, database time, Web Vitals and crash-free rates in one place, with alerts.
  - Good: privacy is enforced by configuration and by unit-tested scrubbers; a DSN-less build is unchanged.
  - Bad: a third-party processor receives (scrubbed) telemetry — list it in the privacy notice if one is published.
  - Bad: client bundle weight and a fast-moving major version to keep current (11.0.0 shipped 2026-09-23: exact
    pin, upgrade deliberately).
  - Bad: dashboard field names track Sentry's evolving datasets; a renamed field needs a JSON edit and a script rerun.

  ### Confirmation

  - `src/lib/observability/scrub.test.ts` — what may leave the app.
  - `src/lib/observability/options.test.ts`, `init.test.ts`, `next-config.test.ts`, `src/instrumentation.test.ts` —
    env guard and restrictive options.
  - `src/lib/api-helpers.observability.test.ts` — 5xx captured once, 4xx never.
  - `src/lib/logger.test.ts` — JSON lines, and no ad-hoc `console.*` left in `src/`.
  - `src/lib/observability/dashboard.test.ts` — dashboard coverage; the script reads `process.env` only.
  ```
- [ ] **Step 5: Index the ADR.** In `docs/decisions/README.md`, after the `0007` line, add:
  ```markdown
  - [0008 — Observability via Sentry with privacy-first defaults](0008-observability-sentry.md)
  ```
- [ ] **Step 6: Run to verify.** `npx vitest run src/lib/observability/docs.test.ts` → all pass.
- [ ] **Step 7: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src`.

---

### Task 12: Controller verification on the QA server

> Controller only (implementers never start servers or browsers). QA server: `homeshare-qa` at 127.0.0.1:3100 (`next dev`, DB `homeshare-qa-pg` on 127.0.0.1:55432, QA-only JWT secret), driven through `.claude/launch.json`. Restarting it is required anyway: `prisma-audit.ts` changed and the Prisma client lives on `globalThis`. Check that no other session is using port 3100 / the loop before restarting.

- [ ] **Step 1: Gates.** `npm run test`, `npx tsc --noEmit`, `npx eslint src` (no new errors), i18n parity → `i18n parity OK`, `node scripts/sentry-dashboard.mjs --dry-run` → 9 widgets.
- [ ] **Step 2: Make the QA tooling DSN-proof.** Next never overrides a variable already present in the process, so pin the Sentry vars in `screenshots/loop-2026-09-27/dev-qa.mjs` (git-ignored) and a DSN in `.env.local` can never leak QA traffic. In its `env` object add:
  ```js
  SENTRY_DSN: process.env.SENTRY_DSN ?? '',
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
  ```
- [ ] **Step 3: Without a DSN — the app is unchanged (R1, R2, R6, R11).** Restart `homeshare-qa`, then:
  1. `curl -s http://127.0.0.1:3100/api/health` → `{"ok":true,"service":"home-share"}`.
  2. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3100/monitoring` → `404` (excluded from the middleware; no tunnel without a DSN).
  3. `curl -s -w " %{http_code}" -X POST http://127.0.0.1:3100/api/auth/login -H "content-type: application/json" --data "not json"` → `{"error":"Failed to sign in"} 500`; the server log (`preview_logs`, search `"level":"error"`) shows ONE JSON line with `"msg":"Failed to sign in"`, `"route":"/api/auth/login"`, `"status":500`, a `requestId`, a numeric `durationMs`, an `error.message` ending in `"[Filtered]" is not valid JSON`, and no `sentryEventId`.
  4. Browser: sign in as a seeded QA user (from `reset-qa.sh`), open `/expenses`, `/shopping`, `/balances`, `/house`: each renders as before; the network list shows no request to `/monitoring` nor to any origin other than 127.0.0.1:3100; the console has no `[Sentry]` line; `preview_logs` has no compile warning or error mentioning `@sentry`.
- [ ] **Step 4: With a local stub DSN — events are scrubbed (R4–R8, R13, R14).**
  1. Confirm port 18797 is free (`netstat -ano | findstr 18797` prints nothing; otherwise pick another free port and use it in the three files below).
  2. Create `screenshots/loop-2026-09-27/sentry-stub.mjs` (git-ignored):
     ```js
     // Local Sentry ingest stub for QA: stores every envelope as one NDJSON row; never forwards anything.
     import { createServer } from 'node:http';
     import { appendFileSync, mkdirSync } from 'node:fs';
     import { gunzipSync, inflateSync } from 'node:zlib';
     import { dirname, join } from 'node:path';
     import { fileURLToPath } from 'node:url';

     const out = join(dirname(fileURLToPath(import.meta.url)), 'sentry-stub', 'envelopes.ndjson');
     mkdirSync(dirname(out), { recursive: true });

     createServer((req, res) => {
       const chunks = [];
       req.on('data', (chunk) => chunks.push(chunk));
       req.on('end', () => {
         let body = Buffer.concat(chunks);
         if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
         else if (req.headers['content-encoding'] === 'deflate') body = inflateSync(body);
         if (req.method === 'POST') {
           appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), url: req.url, envelope: body.toString('utf8') }) + '\n');
         }
         res.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' });
         res.end('{}');
       });
     }).listen(18797, '127.0.0.1', () => console.log('sentry stub on http://127.0.0.1:18797'));
     ```
  3. Create `screenshots/loop-2026-09-27/dev-qa-sentry.mjs` (dynamic import so the variables exist before `dev-qa.mjs` copies `process.env`):
     ```js
     process.env.SENTRY_DSN = 'http://public@127.0.0.1:18797/1';
     process.env.NEXT_PUBLIC_SENTRY_DSN = 'http://public@127.0.0.1:18797/1';
     process.env.SENTRY_TRACES_SAMPLE_RATE = '1';
     process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE = '1';
     await import('./dev-qa.mjs');
     ```
  4. Create `screenshots/loop-2026-09-27/sentry-stub-check.mjs`:
     ```js
     // Asserts that the envelopes the stub received are scrubbed and carry the expected context.
     import { readFileSync } from 'node:fs';

     const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
     const FORBIDDEN = ['ana@example.com', 'qa-secret-token', 'eyJmYWtlIjp0cnVlfQ', '"not json', '"bad json'];
     const rows = readFileSync(new URL('./sentry-stub/envelopes.ndjson', import.meta.url), 'utf8')
       .trim().split('\n').map((line) => JSON.parse(line));

     function items(envelope) {
       const lines = envelope.split('\n').filter(Boolean);
       const out = [];
       for (let i = 1; i + 1 < lines.length; i += 2) {
         let header;
         try { header = JSON.parse(lines[i]); } catch { break; }
         let payload;
         try { payload = JSON.parse(lines[i + 1]); } catch { payload = lines[i + 1]; }
         out.push({ type: header.type, payload });
       }
       return out;
     }

     const problems = [];
     const events = [];
     const spans = [];
     for (const row of rows) {
       for (const needle of FORBIDDEN) if (row.envelope.includes(needle)) problems.push(`"${needle}" leaked (${row.url})`);
       if (/homeshare_(session|group)=(?!\[Filtered\])/.test(row.envelope)) problems.push(`cookie value leaked (${row.url})`);
       if (/"(cookie|authorization)"\s*:/i.test(row.envelope)) problems.push(`cookie/authorization key present (${row.url})`);
       for (const item of items(row.envelope)) {
         if (item.type === 'event') events.push(item.payload);
         if (item.type === 'span' && Array.isArray(item.payload.items)) spans.push(...item.payload.items);
       }
     }

     const tag = (event, name) => event.tags?.[name];
     const value = (event) => event.exception?.values?.[0]?.value ?? '';
     for (const event of events) {
       if (event.user && (Object.keys(event.user).join() !== 'id' || !UUID.test(String(event.user.id)))) {
         problems.push(`user is not { id: uuid }: ${JSON.stringify(event.user)}`);
       }
       if (event.request && ['cookies', 'data', 'query_string', 'env'].some((key) => key in event.request)) {
         problems.push(`request carries forbidden fields: ${Object.keys(event.request).join(', ')}`);
       }
     }
     const loginEvents = events.filter((e) => tag(e, 'route') === '/api/auth/login' && tag(e, 'http_status') === '500' && tag(e, 'request_id'));
     const authed = events.find((e) => tag(e, 'route') === '/api/platforms' && UUID.test(String(e.user?.id)) && UUID.test(String(tag(e, 'house'))));
     const client = events.find((e) => value(e) === 'qa client probe [email]' && UUID.test(String(e.user?.id)) && UUID.test(String(tag(e, 'house'))));
     if (loginEvents.length !== 1) problems.push(`expected exactly 1 tagged 500 event for /api/auth/login, got ${loginEvents.length}`);
     if (!authed) problems.push('no 500 event for /api/platforms with user.id + house');
     if (!client) problems.push('no client probe event with [email] redaction + user.id + house');
     if (events.some((e) => value(e).includes('Item not found'))) problems.push('a 4xx ApiError was reported');

     const spanText = JSON.stringify(spans);
     const dbSpans = /db\.system(\.name)?"\s*:\s*(\{[^}]*"value"\s*:\s*)?"postgresql"/.test(spanText);
     const webVitals = /ui\.webvital\.(lcp|cls)|browser\.web_vital\.(lcp|cls|inp)/.test(spanText);
     const healthSpans = /\/api\/health/.test(spanText);
     if (!dbSpans) problems.push('no database span (db.system = postgresql)');
     if (!webVitals) problems.push('no Web Vitals span');
     if (healthSpans) problems.push('/api/health spans were sent');

     console.log(JSON.stringify({ envelopes: rows.length, events: events.length, spans: spans.length, dbSpans, webVitals }));
     if (problems.length > 0) {
       console.error('FAIL\n- ' + problems.join('\n- '));
       process.exit(1);
     }
     console.log('PASS');
     ```
  5. Add two configurations to `.claude/launch.json` (git-ignored): `sentry-stub` (`node`, args `["screenshots/loop-2026-09-27/sentry-stub.mjs"]`, port 18797) and `homeshare-qa-sentry` (`node`, args `["screenshots/loop-2026-09-27/dev-qa-sentry.mjs"]`, port 3100, url `http://127.0.0.1:3100`). Stop `homeshare-qa`; start `sentry-stub`, then `homeshare-qa-sentry`.
  6. Probes (run each once):
     - Public 5xx carrying secrets: `curl -s -X POST http://127.0.0.1:3100/api/auth/login -H "content-type: application/json" -H "cookie: homeshare_session=eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjp0cnVlfQ.c2ln; homeshare_group=7" -H "authorization: Bearer qa-secret-token" --data "not json ana@example.com"` → 500.
     - Sign in with curl as a seeded QA user, keeping the cookie jar (`-c qa-jar.txt` on `POST /api/auth/login` with that user's seed credentials), then the authenticated 5xx: `curl -s -b qa-jar.txt -X POST http://127.0.0.1:3100/api/platforms -H "content-type: application/json" --data "bad json ana@example.com"` → 500.
     - Expected 4xx ApiError: `curl -s -b qa-jar.txt -X PATCH http://127.0.0.1:3100/api/shopping-items/0b4f7c2e-1d2a-4c3b-9e8f-123456789abc/toggle` → 404 `{"error":"Item not found"}`.
     - `curl -s "http://127.0.0.1:3100/api/health?db=1"` → `{"ok":true,…,"db":true}` (must not produce spans).
     - Browser: sign in as the same user, open `/expenses` (wait for the list), click a filter chip or tab (an interaction for INP), navigate to `/shopping`, then run in the page `setTimeout(() => { throw new Error("qa client probe ana@example.com"); }, 0)`; finally load `/balances` through the address bar (a full page load fires `pagehide`, which flushes pending Web Vitals spans) and wait 10 s.
  7. `node screenshots/loop-2026-09-27/sentry-stub-check.mjs` → a JSON summary with `"dbSpans":true` and `"webVitals":true`, then `PASS`. On `FAIL`, each listed problem names the leaked value or the missing context — fix (systematic-debugging), rerun the gates, clear `sentry-stub/envelopes.ndjson`, repeat Step 4.6–4.7.
  8. Not live-verifiable without a real crash: the GlobalError screen (covered by `locale-cookie.test.ts`, i18n parity, tsc and eslint) and the `/monitoring` tunnel (needs a SaaS DSN — the owner checks it in production, `docs/observability.md` › "Como conferir" step 1).
- [ ] **Step 5: Restore the QA environment.** Stop `homeshare-qa-sentry` and `sentry-stub`; start `homeshare-qa` again (no DSN). Keep the stub files (git-ignored) for future checks.
- [ ] **Step 6: Close the spec.** Tick tasks 1–12 in `docs/specs/007-observability-sentry/tasks.md`. No commit — report the changed-file list to the owner.
