import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No database and no network here: Prisma, web-push and the logger are mocked. Behaviour against a real DB —
// upsert, owner move, the cap of 10, own-only delete, 404/410 deletion — lives in tenant-isolation.test.ts
// (describe "web push (spec 010 …)"), the only file allowed on the shared pglite DB.
const { mockPrisma, mockTx, mockSend, mockLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  mockPrisma: {
    $transaction: vi.fn(),
    pushSubscription: { upsert: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    group: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  // register's interactive transaction client.
  mockTx: {
    $queryRaw: vi.fn(),
    pushSubscription: { upsert: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("web-push", () => ({ default: { sendNotification: mockSend } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

import { pushService } from "@/services/push.service";

const VAPID = { publicKey: "public-key", privateKey: "private-key", subject: "mailto:owner@example.com" };
const HOUSE = { id: 1, publicId: "0192f0c4-0000-7000-8000-00000000abcd", name: "Casa Bolitas" };
const P256DH = Buffer.alloc(65, 4).toString("base64url");
const AUTH = Buffer.alloc(16, 9).toString("base64url");

/** The device token sits in the endpoint's path: it must never reach a log line. */
const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}-SECRETTOKEN`;
const sub = (id: number, userId: number, locale = "en") => ({ id, userId, endpoint: endpoint(id), p256dh: P256DH, auth: AUTH, locale });
const notice = (userId: number, overrides: Partial<{ type: string; actorId: number | null; groupId: number; params: unknown }> = {}) => ({
  userId,
  groupId: HOUSE.id,
  type: "EXPENSE_NEW" as const,
  actorId: 7,
  params: { description: "Electricity", amount: "987654.32" },
  ...overrides,
}) as Parameters<typeof pushService.dispatch>[0][number];

/** A rejection shaped like web-push's WebPushError, which carries the full endpoint and the response body. */
const pushError = (statusCode: number, n: number) =>
  Object.assign(new Error(`Received unexpected response code ${endpoint(n)}`), { statusCode, endpoint: endpoint(n), body: `gone ${endpoint(n)}` });

/** Every payload sent, parsed, in call order. */
const sentPayloads = () => mockSend.mock.calls.map((call) => JSON.parse(call[1] as string));

/** Everything the logger received, as one string. */
const logged = () => JSON.stringify([mockLogger.warn.mock.calls, mockLogger.error.mock.calls, mockLogger.info.mock.calls]);

function configure() {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", VAPID.publicKey);
  vi.stubEnv("VAPID_PRIVATE_KEY", VAPID.privateKey);
  vi.stubEnv("VAPID_SUBJECT", VAPID.subject);
}

function unconfigure() {
  vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "");
}

beforeEach(() => {
  vi.resetAllMocks();
  configure();
  mockPrisma.group.findMany.mockResolvedValue([HOUSE]);
  mockPrisma.user.findMany.mockResolvedValue([{ id: 7, name: "Bruno" }]);
  mockPrisma.pushSubscription.deleteMany.mockResolvedValue({ count: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("pushService.register (criteria 1, 3, 5, 9)", () => {
  const input = { endpoint: endpoint(1), p256dh: P256DH, auth: AUTH, locale: "pt" as const };
  /** The caller's session was signed with sessionVersion 4, and the member's row still holds 4. */
  const SESSION_VERSION = 4;

  beforeEach(() => {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
    mockTx.$queryRaw.mockResolvedValue([{ sessionVersion: SESSION_VERSION }]);
    mockTx.pushSubscription.upsert.mockResolvedValue({ id: 11 });
    mockTx.pushSubscription.findMany.mockResolvedValue([]);
  });

  /** Every write register made, on the transaction or on the app's client. */
  const writes = () => [
    ...mockTx.pushSubscription.upsert.mock.calls,
    ...mockTx.pushSubscription.deleteMany.mock.calls,
    ...mockPrisma.pushSubscription.upsert.mock.calls,
    ...mockPrisma.pushSubscription.deleteMany.mock.calls,
  ];

  it("upserts by endpoint: a new device is created for the caller; a known endpoint moves to the caller with fresh keys and locale", async () => {
    await pushService.register(3, SESSION_VERSION, input);
    expect(mockTx.pushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: input.endpoint },
      create: { userId: 3, endpoint: input.endpoint, p256dh: P256DH, auth: AUTH, locale: "pt" },
      update: { userId: 3, p256dh: P256DH, auth: AUTH, locale: "pt" },
      select: { id: true },
    });
  });

  it("without a locale (the worker's pushsubscriptionchange re-POST): a new row takes the schema default, a known one keeps its locale", async () => {
    await pushService.register(3, SESSION_VERSION, { endpoint: input.endpoint, p256dh: P256DH, auth: AUTH, locale: undefined });
    const args = mockTx.pushSubscription.upsert.mock.calls[0][0];
    expect(args.create).toEqual({ userId: 3, endpoint: input.endpoint, p256dh: P256DH, auth: AUTH });
    expect(args.update).toEqual({ userId: 3, p256dh: P256DH, auth: AUTH });
  });

  it("keeps at most 10 per member: every row past the 9 most recently registered others is deleted — never the one just registered", async () => {
    mockTx.pushSubscription.findMany.mockResolvedValue([{ id: 2 }, { id: 1 }]);
    await pushService.register(3, SESSION_VERSION, input);
    expect(mockTx.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 3, id: { not: 11 } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: 9,
      select: { id: true },
    });
    expect(mockTx.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 3, id: { in: [2, 1] } } });
  });

  it("within the cap nothing is deleted", async () => {
    await pushService.register(3, SESSION_VERSION, input);
    expect(mockTx.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("push not configured → 503 PUSH_NOT_CONFIGURED and nothing is stored (criterion 1)", async () => {
    unconfigure();
    await expect(pushService.register(3, SESSION_VERSION, input)).rejects.toMatchObject({ status: 503, code: "PUSH_NOT_CONFIGURED" });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  // Logout vs register (criterion 9): a register that passed requireSession just before a logout committed must not
  // store a row after the logout deleted them all. Logout bumps sessionVersion BEFORE it deletes (one transaction), and
  // register locks the member's row and re-reads the version first: whichever runs second sees the other's commit.
  it("locks the member's row and re-reads its sessionVersion first, then writes everything on that same transaction", async () => {
    mockTx.pushSubscription.findMany.mockResolvedValue([{ id: 2 }]);
    await pushService.register(3, SESSION_VERSION, input);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = mockTx.$queryRaw.mock.calls[0];
    expect((sql as TemplateStringsArray).join("$")).toBe('SELECT "sessionVersion" FROM "User" WHERE id = $ FOR UPDATE');
    expect(values).toEqual([3]); // a bound parameter, never interpolated text
    const lockedAt = mockTx.$queryRaw.mock.invocationCallOrder[0];
    expect(lockedAt).toBeLessThan(mockTx.pushSubscription.upsert.mock.invocationCallOrder[0]);
    expect(lockedAt).toBeLessThan(mockTx.pushSubscription.findMany.mock.invocationCallOrder[0]);
    expect(lockedAt).toBeLessThan(mockTx.pushSubscription.deleteMany.mock.invocationCallOrder[0]);
    // Nothing on the app's client: outside the transaction the lock would not cover it.
    expect(mockPrisma.pushSubscription.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["the session is older than the member's row (a logout or password change committed first)", [{ sessionVersion: SESSION_VERSION + 1 }]],
    ["the member's row is gone", []],
  ])("401 SESSION_REVOKED and nothing stored when %s", async (_label, rows) => {
    mockTx.$queryRaw.mockResolvedValue(rows);
    await expect(pushService.register(3, SESSION_VERSION, input)).rejects.toMatchObject({ status: 401, code: "SESSION_REVOKED" });
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe("pushService.unregister (criterion 5)", () => {
  it("deletes only the caller's row for that endpoint; no row is not an error (idempotent)", async () => {
    await expect(pushService.unregister(3, endpoint(1))).resolves.toBeUndefined();
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 3, endpoint: endpoint(1) } });
  });

  it("works while push is not configured (a device can always clean up)", async () => {
    unconfigure();
    await pushService.unregister(3, endpoint(1));
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("pushService.deleteAllForUser (criterion 9)", () => {
  it("returns the given client's deleteMany promise un-awaited, so it joins a batch $transaction or runs on a tx", () => {
    const op = { batched: true };
    const db = { pushSubscription: { deleteMany: vi.fn().mockReturnValue(op) } };
    expect(pushService.deleteAllForUser(3, db as never)).toBe(op);
    expect(db.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 3 } });
    expect(mockPrisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("defaults to the app's client", () => {
    pushService.deleteAllForUser(3);
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 3 } });
  });
});

describe("pushService.dispatch (criteria 6, 7, 13)", () => {
  it("push not configured: no query, nothing sent (criterion 1)", async () => {
    unconfigure();
    await pushService.dispatch([notice(3)]);
    expect(mockPrisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("no notice: no query", async () => {
    await pushService.dispatch([]);
    expect(mockPrisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  it("nobody subscribed: one query, no house or actor lookup, nothing sent", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([]);
    await pushService.dispatch([notice(3), notice(4)]);
    expect(mockPrisma.pushSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.group.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("one push per subscription, rendered in that subscription's locale, with the design's send options — one query per kind", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3, "en"), sub(2, 3, "pt"), sub(3, 4, "es")]);
    await pushService.dispatch([notice(3), notice(4), notice(5)]);

    expect(mockPrisma.pushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: [3, 4, 5] } } })
    );
    expect(mockPrisma.group.findMany).toHaveBeenCalledWith({ where: { id: { in: [1] } }, select: { id: true, publicId: true, name: true } });
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({ where: { id: { in: [7] } }, select: { id: true, name: true } });
    expect(mockSend).toHaveBeenCalledTimes(3);
    const [subscription, , options] = mockSend.mock.calls[0];
    expect(subscription).toEqual({ endpoint: endpoint(1), keys: { p256dh: P256DH, auth: AUTH } });
    expect(options).toEqual({ TTL: 86400, urgency: "normal", timeout: 10000, vapidDetails: VAPID });
    const url = `/expenses?house=${HOUSE.publicId}`;
    const tag = `EXPENSE_NEW:${HOUSE.publicId}`;
    expect(sentPayloads()).toEqual([
      { title: "Casa Bolitas", body: "Bruno added “Electricity”", url, tag },
      { title: "Casa Bolitas", body: "Bruno adicionou “Electricity”", url, tag },
      { title: "Casa Bolitas", body: "Bruno añadió “Electricity”", url, tag },
    ]);
    expect(JSON.stringify(sentPayloads())).not.toMatch(/987|654/);
  });

  it("automatic notices (no actor) skip the actor lookup", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3)]);
    await pushService.dispatch([notice(3, { type: "DEBT_REMINDER", actorId: null, params: { amount: "10.00" } })]);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(sentPayloads()[0].body).toBe("You have an open balance to settle");
  });

  it("a notice whose house is gone by now (deleted after the insert) is skipped", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3)]);
    mockPrisma.group.findMany.mockResolvedValue([]);
    await pushService.dispatch([notice(3)]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends with a concurrency of 10", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue(Array.from({ length: 25 }, (_, i) => sub(i + 1, 3)));
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    mockSend.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => releases.push(() => (inFlight--, resolve())));
    });

    const done = pushService.dispatch([notice(3)]);
    await vi.waitFor(() => expect(releases).toHaveLength(10));
    for (let released = 0; released < 25; released++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(released));
      releases[released]();
    }
    await done;

    expect(mockSend).toHaveBeenCalledTimes(25);
    expect(maxInFlight).toBe(10);
  });

  it("404 and 410 delete the subscription; a 500 and a network error keep it and log the push service's host and status only (criteria 7, 13)", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3), sub(2, 3), sub(3, 3), sub(4, 3), sub(5, 3)]);
    mockSend
      .mockRejectedValueOnce(pushError(410, 1))
      .mockRejectedValueOnce(pushError(404, 2))
      .mockRejectedValueOnce(pushError(500, 3))
      .mockRejectedValueOnce(new Error(`socket hang up ${endpoint(4)}`))
      .mockResolvedValueOnce({ statusCode: 201 });

    await pushService.dispatch([notice(3)]);

    expect(mockSend).toHaveBeenCalledTimes(5); // never retried
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
    expect(mockLogger.warn.mock.calls).toEqual([
      ["push delivery failed", { host: "fcm.googleapis.com", statusCode: 500 }],
      ["push delivery failed", { host: "fcm.googleapis.com", statusCode: undefined, reason: "request_failed" }],
    ]);
    // Neither the error object (WebPushError carries the full endpoint and body) nor any key reaches the logger.
    expect(logged()).not.toMatch(/SECRETTOKEN|device-|\/fcm\/send/);
    expect(logged()).not.toContain(P256DH);
    expect(logged()).not.toContain(AUTH);
  });

  it("a failure without an HTTP status logs Node's error code or a fixed reason, never the message: a bad VAPID key or a dead network is told apart from a push-service answer", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3), sub(2, 3), sub(3, 3), sub(4, 3)]);
    mockSend
      .mockRejectedValueOnce(Object.assign(new Error(`connect ECONNRESET ${endpoint(1)}`), { code: "ECONNRESET" }))
      .mockRejectedValueOnce(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }))
      // web-push's own validation errors carry no code, and quote the VAPID subject (an e-mail) or the endpoint.
      .mockRejectedValueOnce(new Error("Vapid subject is not a valid URL. mailto:owner@example.com"))
      .mockRejectedValueOnce(Object.assign(new Error("odd failure"), { code: `weird ${endpoint(4)}` }));

    await pushService.dispatch([notice(3)]);

    const failed = (reason: string) => ["push delivery failed", { host: "fcm.googleapis.com", statusCode: undefined, reason }];
    expect(mockLogger.warn.mock.calls).toEqual([
      failed("ECONNRESET"),
      failed("ERR_TLS_CERT_ALTNAME_INVALID"),
      failed("request_failed"),
      failed("request_failed"),
    ]);
    expect(logged()).not.toMatch(/SECRETTOKEN|device-|owner@|Vapid|altnames|odd|weird/);
    expect(mockPrisma.pushSubscription.deleteMany).not.toHaveBeenCalled(); // kept: none of these says the device is gone
  });

  it("never sends to a row the current validator rejects (rows outlive validator changes): it is deleted instead, and the deletion is logged with a count only", async () => {
    const ssrf = { ...sub(1, 3), endpoint: "https://127.0.0.1;.push.apple.com/x" };
    const http = { ...sub(2, 3), endpoint: "http://fcm.googleapis.com/fcm/send/x" };
    mockPrisma.pushSubscription.findMany.mockResolvedValue([ssrf, http, sub(3, 3)]);

    await pushService.dispatch([notice(3)]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].endpoint).toBe(endpoint(3));
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1, 2] } } });
    expect(mockLogger.warn.mock.calls).toEqual([["push endpoint rejected", { count: 2 }]]);
    expect(logged()).not.toMatch(/127\.0\.0\.1|fcm\/send/);
  });

  it("never throws: a failing query is logged with counts only and the action that produced the notice is unaffected", async () => {
    mockPrisma.pushSubscription.findMany.mockRejectedValue(new Error("connection lost"));
    await expect(pushService.dispatch([notice(3)])).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("push dispatch failed", { notices: 1 }, expect.any(Error));
  });

  it("a failing cleanup of expired rows is logged and never thrown", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3)]);
    mockSend.mockRejectedValueOnce(pushError(410, 1));
    mockPrisma.pushSubscription.deleteMany.mockRejectedValue(new Error("connection lost"));
    await expect(pushService.dispatch([notice(3)])).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith("push: removing expired subscriptions failed", { count: 1 }, expect.any(Error));
  });
});

describe("pushService.sendTest (criterion 10)", () => {
  it("push not configured → 503 PUSH_NOT_CONFIGURED, no query", async () => {
    unconfigure();
    await expect(pushService.sendTest(3)).rejects.toMatchObject({ status: 503, code: "PUSH_NOT_CONFIGURED" });
    expect(mockPrisma.pushSubscription.findMany).not.toHaveBeenCalled();
  });

  it("no subscription → 409 NO_PUSH_SUBSCRIPTION, nothing sent", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([]);
    await expect(pushService.sendTest(3)).rejects.toMatchObject({ status: 409, code: "NO_PUSH_SUBSCRIPTION" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends the test notice to every subscription of the member in its locale and counts { sent, failed }; a 410 row is deleted", async () => {
    mockPrisma.pushSubscription.findMany.mockResolvedValue([sub(1, 3, "en"), sub(2, 3, "pt"), sub(3, 3, "es"), sub(4, 3, "fr")]);
    mockSend
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(pushError(410, 3))
      .mockRejectedValueOnce(pushError(500, 4));

    expect(await pushService.sendTest(3)).toEqual({ sent: 2, failed: 2 });

    expect(mockPrisma.pushSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 3 } }));
    expect(sentPayloads().map((p) => p.body)).toEqual([
      "Notifications are working on this device",
      "As notificações estão funcionando neste dispositivo",
      "Las notificaciones funcionan en este dispositivo",
      "Les notifications fonctionnent sur cet appareil",
    ]);
    expect(sentPayloads()[0]).toEqual({ title: "Home Share", body: "Notifications are working on this device", url: "/notifications", tag: "TEST" });
    expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [3] } } });
  });
});
