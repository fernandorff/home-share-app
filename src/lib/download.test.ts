import { describe, it, expect } from "vitest";
import { fileNameFromContentDisposition } from "./download";

const FALLBACK = "home-share-expenses-2026-10-04.csv";

describe("fileNameFromContentDisposition", () => {
  it("reads a quoted file name", () =>
    expect(fileNameFromContentDisposition('attachment; filename="home-share-expenses-2026-10-03.csv"', FALLBACK)).toBe(
      "home-share-expenses-2026-10-03.csv"
    ));
  it("reads an unquoted file name", () =>
    expect(fileNameFromContentDisposition("attachment; filename=expenses.csv", FALLBACK)).toBe("expenses.csv"));
  it("reads a quoted name containing a semicolon", () =>
    expect(fileNameFromContentDisposition('attachment; filename="a;b.csv"', FALLBACK)).toBe("a;b.csv"));
  it("prefers the RFC 5987 filename* form when both are present", () =>
    expect(
      fileNameFromContentDisposition(`attachment; filename="fallback.csv"; filename*=UTF-8''despesas%20%C3%A9.csv`, FALLBACK)
    ).toBe("despesas é.csv"));
  it("falls back when the header is missing, empty or has no file name", () => {
    expect(fileNameFromContentDisposition(null, FALLBACK)).toBe(FALLBACK);
    expect(fileNameFromContentDisposition("", FALLBACK)).toBe(FALLBACK);
    expect(fileNameFromContentDisposition("attachment", FALLBACK)).toBe(FALLBACK);
    expect(fileNameFromContentDisposition('attachment; filename=""', FALLBACK)).toBe(FALLBACK);
  });
  it("keeps only the base name, so a header can never point the download elsewhere", () => {
    expect(fileNameFromContentDisposition('attachment; filename="../../etc/passwd"', FALLBACK)).toBe("passwd");
    expect(fileNameFromContentDisposition('attachment; filename="C:\\temp\\x.csv"', FALLBACK)).toBe("x.csv");
  });
  it("falls back when filename* is malformed and there is no plain filename", () =>
    expect(fileNameFromContentDisposition("attachment; filename*=UTF-8''%E0%A4%A", FALLBACK)).toBe(FALLBACK));
});
