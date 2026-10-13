import { describe, it, expect } from "vitest";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";

// R3-27: the label's colon comes from the locale — fr writes a non-breaking space before it
// ("devise : USD → BRL"), the rest glue it to the label.
describe("Common.labelColon (R3-27)", () => {
  it("glues the colon to the label in en/pt/es", () => {
    for (const messages of [en, pt, es]) {
      expect(messages.Common.labelColon).toBe("{label}:");
    }
  });

  it("puts a non-breaking space before the colon in fr", () => {
    expect(fr.Common.labelColon).toBe("{label}\u00a0:");
  });
});
