import { describe, it, expect } from "vitest";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import { FALLBACK_COPY, globalErrorCopy } from "./global-error-copy";

describe("globalErrorCopy (R13 — the last-resort screen always has text)", () => {
  it("falls back to the bundled English copy before/without a loaded locale", () => {
    expect(globalErrorCopy()).toEqual(FALLBACK_COPY);
    expect(globalErrorCopy(null)).toEqual(FALLBACK_COPY);
  });

  it("uses the loaded locale strings when available", () => {
    expect(globalErrorCopy(pt.GlobalError)).toEqual(pt.GlobalError);
  });

  it("falls back per key when a loaded string is missing or blank", () => {
    const copy = globalErrorCopy({ title: "Algo deu errado", description: "", reload: undefined });
    expect(copy).toEqual({
      title: "Algo deu errado",
      description: FALLBACK_COPY.description,
      reload: FALLBACK_COPY.reload,
    });
  });

  it("keeps the bundled fallback identical to en.json (no drift)", () => {
    expect(FALLBACK_COPY).toEqual(en.GlobalError);
  });
});
