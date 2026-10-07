import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type * as ApiHelpers from "@/lib/api-helpers";
import type * as NotificationServiceModule from "@/services/notification.service";

// Preferences are per user (all houses): the route uses requireSession() only. The service is faked except its
// real input parser, which the fake setPreference runs first — so the 400 NOTIFICATION_PREF_INVALID the client
// sees is the service's own validation (the route passes the body through and never re-validates it).
const { mockRequireSession, mockGetPreferences, mockSetPreference, mockRequireActiveGroup } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockGetPreferences: vi.fn(),
  mockSetPreference: vi.fn(),
  mockRequireActiveGroup: vi.fn(),
}));
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHelpers>();
  return { ...actual, requireSession: mockRequireSession, requireActiveGroup: mockRequireActiveGroup };
});
vi.mock("@/services/notification.service", async (importOriginal) => {
  const actual = await importOriginal<typeof NotificationServiceModule>();
  return { ...actual, notificationService: { getPreferences: mockGetPreferences, setPreference: mockSetPreference } };
});
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// handleApiError reads the request headers and talks to Sentry: both are irrelevant to these contracts.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("@sentry/nextjs", () => ({ getClient: () => undefined, flush: async () => true, addBreadcrumb: () => {} }));
// The real notification.service module (above) imports the push path (spec 010): no test may reach the network.
vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));

import { GET, PUT } from "./route";
import { parsePreferenceInput } from "@/services/notification.service";

const session = { userId: 2, publicId: "bob", name: "Bob", sessionVersion: 1, iat: 0 };
const ALL_ON = { EXPENSE_NEW: true, PAYMENT_RECEIVED: true, DEBT_REMINDER: true, RECURRING_DUE: true };
const unauthenticated = { ok: false, response: NextResponse.json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" }, { status: 401 }) };

const put = (payload: unknown) =>
  PUT(
    new Request("http://localhost/api/notification-preferences", {
      method: "PUT",
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    })
  );

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireSession.mockResolvedValue({ ok: true, session });
  mockGetPreferences.mockResolvedValue(ALL_ON);
  mockSetPreference.mockImplementation(async (_userId: number, raw: unknown) => {
    const { type, enabled } = parsePreferenceInput(raw);
    return { ...ALL_ON, [type]: enabled };
  });
});

describe("GET /api/notification-preferences (spec 009 — criterion 13)", () => {
  it("answers 200 { preferences } with every type's effective value for the session user", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preferences: ALL_ON });
    expect(mockGetPreferences).toHaveBeenCalledWith(2);
  });

  it("needs a session but no active house (preferences span every house)", async () => {
    await GET();
    expect(mockRequireActiveGroup).not.toHaveBeenCalled();

    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await GET()).status).toBe(401);
    expect(mockGetPreferences).toHaveBeenCalledTimes(1);
  });
});

describe("PUT /api/notification-preferences (spec 009 — criteria 9, 13)", () => {
  it("stores { type, enabled } for the session user and answers 200 with the updated map", async () => {
    const res = await put({ type: "EXPENSE_NEW", enabled: false });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preferences: { ...ALL_ON, EXPENSE_NEW: false } });
    expect(mockSetPreference).toHaveBeenCalledWith(2, { type: "EXPENSE_NEW", enabled: false });
    expect(mockRequireActiveGroup).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown type", { type: "SHOPPING_NEW", enabled: true }],
    ["a prototype key as type", { type: "constructor", enabled: true }],
    ["a non-boolean enabled", { type: "EXPENSE_NEW", enabled: "false" }],
    ["a missing enabled", { type: "EXPENSE_NEW" }],
    ["null", null],
    ["malformed JSON", "{ type: EXPENSE_NEW"],
  ])("%s → 400 NOTIFICATION_PREF_INVALID", async (_label, payload) => {
    const res = await put(payload);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NOTIFICATION_PREF_INVALID");
  });

  it("passes the session gate's 401 through and stores nothing", async () => {
    mockRequireSession.mockResolvedValueOnce(unauthenticated);
    expect((await put({ type: "EXPENSE_NEW", enabled: false })).status).toBe(401);
    expect(mockSetPreference).not.toHaveBeenCalled();
  });
});
