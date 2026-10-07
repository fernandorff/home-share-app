import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/messages/en.json";

// The page is client-only and fetches in effects (no DOM environment here), so pin its contracts on the source,
// like the other page-level tests.
const source = readFileSync(join(process.cwd(), "src/app/(app)/activity/page.tsx"), "utf8");

/** The Detailed feed's curated field list for one entity (the SNAPSHOT_FIELDS entry), in order. */
function presetOf(entity: string): string[] {
  const match = source.match(new RegExp(`\\b${entity}: \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`no SNAPSHOT_FIELDS entry for ${entity}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Detailed field preset — RecurringExpense (spec 008)", () => {
  const fields = presetOf("RecurringExpense");

  it("lists the rule's own fields, and none of the internal ones", () => {
    expect(fields).toEqual([
      "description", "amount", "dayOfMonth", "payerId", "splitMode", "participantIds", "pausedAt", "pauseReason", "skippedPeriods",
    ]);
  });

  it("every field has a label (a missing one would print the raw key)", () => {
    expect(fields.filter((f) => !(f in en.Activity.field))).toEqual([]);
  });
});

describe("who an actor-less entry names (spec 008, criterion 13)", () => {
  it("both feeds ask actorLabelKey instead of hard-coding \"Someone\"", () => {
    expect(source.match(/actorLabelKey\(/g)).toHaveLength(2);
    expect(source).not.toContain('t("system")');
  });
});

describe("month of a skip (spec 008)", () => {
  it("the Summary formats it for the viewer's locale", () => {
    expect(source).toContain("summaryPhrase(e, locale)");
  });
});

describe("a rule's skipped months in Detailed (spec 008, E3)", () => {
  it("render through periodListLabel in the viewer's locale, not as raw YYYY-MM", () => {
    expect(source).toContain('field === "skippedPeriods" && Array.isArray(value)');
    expect(source).toContain("periodListLabel(value, locale)");
  });
});

describe("the Automatic actor's avatar (spec 008, E4)", () => {
  it("both feeds draw ↻ instead of an initial, keeping the accessible name", () => {
    expect(source.match(/glyph=\{actorKey === "automatic" \? "↻" : undefined\}/g)).toHaveLength(2);
    const member = readFileSync(join(process.cwd(), "src/components/ui/Member.tsx"), "utf8");
    // The glyph itself is hidden from assistive tech ("clockwise open circle arrow"); the label names the actor.
    expect(member).toContain("glyph ? <span aria-hidden>{glyph}</span> : label.text");
    expect(member).toContain("aria-label={name}");
  });
});
