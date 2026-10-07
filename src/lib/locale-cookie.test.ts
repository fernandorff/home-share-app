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
