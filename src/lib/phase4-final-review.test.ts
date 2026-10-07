import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import pt from "@/messages/pt.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";

const LOCALES = { en, pt, es, fr } as const;
type Locale = keyof typeof LOCALES;
const ALL = Object.keys(LOCALES) as Locale[];

function tr(locale: Locale, namespace: "Expenses" | "Activity") {
  return createTranslator({ locale, messages: LOCALES[locale], namespace });
}

// Phase 4 final review, M4: the % mismatch reason now stands on its own line, like Amount mode's reason.
describe("% mismatch reason (M4)", () => {
  it.each(["pt", "es", "fr"] as const)("%s: starts with a capital letter", (locale) => {
    const reason = tr(locale, "Expenses")("percentMissing", { pct: 30 });
    expect(reason.charAt(0)).toBe(reason.charAt(0).toUpperCase());
    expect(reason.charAt(0)).not.toBe(reason.charAt(0).toLowerCase());
  });

  it("pt/es/fr: the exact texts", () => {
    expect(tr("pt", "Expenses")("percentMissing", { pct: 30 })).toBe("Faltam 30% para 100%");
    expect(tr("es", "Expenses")("percentMissing", { pct: 30 })).toBe("Faltan 30% para 100%");
    expect(tr("fr", "Expenses")("percentMissing", { pct: 30 })).toBe("Il manque 30% pour atteindre 100%");
  });
});

// M9: the expense History uses the same verbs as the Activity tabs (added / updated / removed).
describe("expense History verbs (M9)", () => {
  it.each(ALL)("%s: History CREATE/UPDATE/DELETE start with the Activity verbs", (locale) => {
    const history = tr(locale, "Expenses");
    const action = tr(locale, "Activity");
    expect(history("history.CREATE").startsWith(action("action.CREATE"))).toBe(true);
    expect(history("history.UPDATE")).toBe(action("action.UPDATE"));
    expect(history("history.DELETE").startsWith(action("action.DELETE"))).toBe(true);
  });

  it("en: the exact texts", () => {
    const t = tr("en", "Expenses");
    expect(t("history.CREATE")).toBe("added this expense");
    expect(t("history.UPDATE")).toBe("updated");
    expect(t("history.DELETE")).toBe("removed this expense");
  });
});

// M10: the delete-account dialog states the effect before the irreversibility sentence.
describe("delete-account dialog body (M10)", () => {
  const source = readFileSync(join(process.cwd(), "src/app/(app)/account/page.tsx"), "utf8");

  it("renders the effect (the hint) and then the irreversibility sentence in the confirmation body", () => {
    const body = source.slice(source.indexOf('t("deleteAccountLastAdmin"'));
    const effect = body.indexOf('t("deleteAccountHint")');
    const note = body.indexOf('t("deleteAccountConfirmPrompt")');
    expect(effect).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(effect);
  });
});

// Older 1: a selection belongs to the list it was made on — the bulk-delete dialog can only name what is in
// view, so a filter (or sort) change must not leave hidden ids selected.
describe("expenses selection vs filters (Older 1)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/expenses/page.tsx"), "utf8");

  it("resets the selection whenever the list query (filters, sort) changes", () => {
    expect(page).toContain("const listKey = buildListUrl(1);");
    const at = page.indexOf("if (selectionListKey !== listKey) {");
    expect(at).toBeGreaterThan(page.indexOf("const [selected, setSelected]"));
    expect(page.slice(at, at + 160)).toContain("setSelected(new Set());");
  });

  it("no longer documents that filters keep the selection", () => {
    expect(page).not.toContain("filters don't clear `selected`");
  });
});

// Fix round 1: the export downloads through fetch, so a failure shows a translated toast (EXPORT_FAILED)
// instead of the browser navigating to a JSON error body.
describe("expenses export download (Older 2)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/expenses/page.tsx"), "utf8");

  it("no longer navigates the page to the export URL", () => {
    expect(page).not.toContain("window.location.href = `/api/expenses/export");
  });

  it("downloads the blob under the server's file name and reports failures through the toast", () => {
    expect(page).toContain("fetch(`/api/expenses/export?date=${day}`)");
    expect(page).toContain("fileNameFromContentDisposition(");
    expect(page).toContain("URL.createObjectURL(blob)");
    expect(page).toContain("setTimeout(() => URL.revokeObjectURL(url), 1000)");
    // a lost session goes to the login page like every other request (lib/api)
    expect(page).toContain("if (res.status === 401) redirectOnSessionLoss(data?.code);");
    expect(page).toContain('apiErr(err, tApiErrors("EXPORT_FAILED"))');
    expect(page).toContain("onSelect={exportCsv}");
  });
});

describe("expenses reload resets the selection (fix round 2)", () => {
  const page = readFileSync(join(process.cwd(), "src/app/(app)/expenses/page.tsx"), "utf8");

  it("reloadAll clears the selection, since the list restarts at its first page", () => {
    const at = page.indexOf("function reloadAll() {");
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at, page.indexOf("\n  }\n", at))).toContain("setSelected(new Set());");
  });
});

describe("CSV size / line-count errors are file-level (fix round 2)", () => {
  it.each(ALL)("%s: CsvErrors has CSV_TOO_LARGE and CSV_TOO_MANY_LINES", (locale) => {
    const messages = LOCALES[locale].CsvErrors as Record<string, string>;
    expect(messages.CSV_TOO_LARGE.length).toBeGreaterThan(0);
    expect(messages.CSV_TOO_MANY_LINES.length).toBeGreaterThan(0);
  });
});
