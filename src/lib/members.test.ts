import { describe, it, expect } from "vitest";
import { avatarLabel } from "./members";

describe("avatarLabel (R2-11)", () => {
  it("keeps two initials from a 30px avatar up, never under 12px", () => {
    expect(avatarLabel("Carla QA", 32)).toEqual({ text: "CQ", fontSize: 13 });
    expect(avatarLabel("Carla QA", 30)).toEqual({ text: "CQ", fontSize: 12 });
  });
  it("shows only the first initial on smaller avatars, at 12px or more", () => {
    expect(avatarLabel("Carla QA", 22)).toEqual({ text: "C", fontSize: 12 });
    expect(avatarLabel("Júlia Caminho Feliz", 18)).toEqual({ text: "J", fontSize: 12 });
    expect(avatarLabel("Bruno QA", 26)).toEqual({ text: "B", fontSize: 14 });
  });
  it("falls back to ? for a blank name", () => expect(avatarLabel("  ", 22).text).toBe("?"));
});

describe("avatarLabel for house avatars (R3-29)", () => {
  const houses = ["Casa QA", "Casa Carla", "Casa Dani"];
  it("at 22px every house reads as the same single initial", () => {
    expect(houses.map((h) => avatarLabel(h, 22).text)).toEqual(["C", "C", "C"]);
  });
  it("at the drawer's 30px size houses tell apart by two initials, at the 12px floor", () => {
    expect(houses.map((h) => avatarLabel(h, 30))).toEqual([
      { text: "CQ", fontSize: 12 },
      { text: "CC", fontSize: 12 },
      { text: "CD", fontSize: 12 },
    ]);
  });
});
