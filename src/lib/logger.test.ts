import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

  it("redacts e-mails and URL query strings in the message and in string fields, on stdout and in the breadcrumb", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("invite for ana@example.com failed at /auth/set-password?token=abc123", {
      url: "https://homeshare.app/auth/set-password?token=abc123&next=/",
      owner: "ana@example.com",
      status: 400,
      ok: false,
    });
    expect(lineOf(out)).toMatchObject({
      msg: "invite for [email] failed at /auth/set-password",
      url: "https://homeshare.app/auth/set-password",
      owner: "[email]",
      status: 400,
      ok: false,
    });
    expect(out.mock.calls[0][0]).not.toMatch(/ana@example\.com|abc123/);
    expect(mockAddBreadcrumb).toHaveBeenCalledWith({
      category: "log",
      level: "info",
      message: "invite for [email] failed at /auth/set-password",
      data: { url: "https://homeshare.app/auth/set-password", owner: "[email]", status: 400, ok: false },
    });
  });

  it("reduces a Prisma client error to its final reason line: no invocation dump, no names or amounts, in message or stack", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const prismaError = new Error(
      "\nInvalid `prisma.expense.create()` invocation:\n\n{\n  data: {\n    description: \"Zelda\",\n    amount: 98.76\n  }\n}\n\nUnique constraint failed on the fields: (`publicId`)"
    );
    prismaError.name = "PrismaClientKnownRequestError";
    logger.error("Failed to create expense", { status: 500 }, prismaError);
    const line = lineOf(err);
    expect(line.error.name).toBe("PrismaClientKnownRequestError");
    expect(line.error.message).toBe("Unique constraint failed on the fields: (`publicId`)");
    expect(line.error.stack).toMatch(/^PrismaClientKnownRequestError: Unique constraint failed on the fields: \(`publicId`\)\n\s+at /);
    expect(err.mock.calls[0][0]).not.toMatch(/Zelda|98\.76|invocation|data:/);
  });

  it("cuts a push-service endpoint (a device token) to its origin in the message, fields, error and breadcrumb (spec 010, criterion 13)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const endpoint = "https://fcm.googleapis.com/fcm/send/dXJsOnRva2Vu:APA91bH-SECRET";
    const wns = "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB-SECRET";
    logger.warn(`push to ${endpoint} failed`, { url: wns }, new Error(`Received unexpected response code ${endpoint}`));
    const line = lineOf(warn);
    expect(line).toMatchObject({
      msg: "push to https://fcm.googleapis.com/[Filtered] failed",
      url: "https://wns2-par02p.notify.windows.com/[Filtered]",
      error: { message: "Received unexpected response code https://fcm.googleapis.com/[Filtered]" },
    });
    expect(warn.mock.calls[0][0]).not.toContain("SECRET");
    expect(JSON.stringify(mockAddBreadcrumb.mock.calls)).not.toContain("SECRET");
  });

  it("keeps the full message of a non-Prisma error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("boom", {}, new RangeError("line one\nline two"));
    expect(lineOf(err).error.message).toBe("line one\nline two");
  });

  describe("never throws into the caller", () => {
    const FAILURE_LINE = { level: "error", msg: "logger failed to write a log entry" };

    it("survives values that cannot be serialized, as the error or as a field", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect(() => logger.error("audit log failed", {}, Object.create(null))).not.toThrow();
      expect(lineOf(err)).toEqual(FAILURE_LINE);
      expect(() => logger.info("odd field", { weird: Object.create(null) as unknown as string })).not.toThrow();
    });

    it("survives a throwing breadcrumb hook, reporting a fixed line that carries none of the entry", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      mockAddBreadcrumb.mockImplementation(() => {
        throw new Error("beforeBreadcrumb exploded");
      });
      expect(() => logger.warn("slow query for ana@example.com", { route: "/api/expenses" })).not.toThrow();
      expect(err).toHaveBeenCalledTimes(1);
      expect(lineOf(err)).toEqual(FAILURE_LINE);
    });

    it("survives a throwing console sink, even when the fallback sink throws too", () => {
      const boom = () => {
        throw new Error("EPIPE");
      };
      vi.spyOn(console, "log").mockImplementation(boom);
      vi.spyOn(console, "error").mockImplementation(boom);
      expect(() => logger.info("cache warmed")).not.toThrow();
      expect(() => logger.error("failed", {}, new Error("x"))).not.toThrow();
    });
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
