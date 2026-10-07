import { describe, it, expect } from "vitest";
import { authErrorField, firstErrorField, validateLogin, validateRegister } from "./auth-form";

describe("authErrorField (R3-03)", () => {
  it("routes a field's API codes to that field", () => {
    expect(authErrorField("MISSING_USERNAME")).toBe("username");
    expect(authErrorField("INVALID_USERNAME")).toBe("username");
    expect(authErrorField("USERNAME_TAKEN")).toBe("username");
    expect(authErrorField("INVALID_PASSWORD")).toBe("password");
    expect(authErrorField("PASSWORD_TOO_COMMON")).toBe("password");
    expect(authErrorField("PASSWORD_NO_COMPLEXITY")).toBe("password");
    expect(authErrorField("INVALID_NAME")).toBe("name");
  });
  it("keeps whole-form errors in the banner", () => {
    for (const code of ["INVALID_CREDENTIALS", "RATE_LIMITED", "USE_GOOGLE", "SOMETHING_ELSE", "constructor", "toString", undefined]) {
      expect(authErrorField(code)).toBeNull();
    }
  });
});

describe("validateLogin (R3-03)", () => {
  it("marks every empty field as required", () =>
    expect(validateLogin({ username: " ", password: "" })).toEqual({ username: "fieldRequired", password: "fieldRequired" }));
  it("passes filled fields", () => expect(validateLogin({ username: "ana", password: "x" })).toEqual({}));
});

describe("validateRegister (R3-03)", () => {
  it("empty first, then each field's own rule — its hint", () => {
    expect(validateRegister({ name: "", username: "", password: "" }))
      .toEqual({ name: "fieldRequired", username: "fieldRequired", password: "fieldRequired" });
    expect(validateRegister({ name: "Ana", username: "an", password: "short1" }))
      .toEqual({ username: "usernameHint", password: "passwordHint" });
    expect(validateRegister({ name: "Ana", username: "ana", password: "longenough1" })).toEqual({});
  });
});

describe("firstErrorField (R3-03)", () => {
  it("follows the form's order", () =>
    expect(firstErrorField(["name", "username", "password"], { password: 1, username: 1 })).toBe("username"));
  it("is null without errors", () => expect(firstErrorField(["name"], {})).toBeNull());
});
