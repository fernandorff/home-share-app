import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The modal needs session/toast/intl providers and a client-side submit to reach its error and result states,
// and there is no DOM environment here — pin the R3-12 wiring on the source, as text-floor.test.ts does.
const source = readFileSync(join(process.cwd(), "src/components/expenses/ImportCsvModal.tsx"), "utf8");

describe("ImportCsvModal outcome placement (R3-12)", () => {
  it("renders a file-level error once, right under the file row and before the hint", () => {
    expect(source.match(/role="alert"/g)).toHaveLength(1);
    const error = source.indexOf('id={fileErrorId}');
    expect(error).toBeGreaterThan(source.indexOf('id="imp-file"'));
    expect(error).toBeLessThan(source.indexOf("<p id={fileHintId}"));
  });

  it("ties a file-level error to the file input (aria-invalid + aria-describedby) and turns the file name red", () => {
    expect(source).toContain("aria-invalid={fileLevelError ? true : undefined}");
    expect(source).toContain("aria-describedby={fileLevelError ? `${fileErrorId} ${fileHintId}` : fileHintId}");
    expect(source).toContain('fileLevelError ? "text-debt" : "text-ink-soft"');
  });

  it("blames the file only for a CSV error code; network, 429, 500 and payer/platform errors do not", () => {
    // fileLevel comes from the CsvErrors namespace, stored next to the message it labels.
    expect(source).toContain("const fileLevel = !!code && tCsv.has(code);");
    expect(source).toContain("setFormError({ message, fileLevel });");
    expect(source).toContain("const fileLevelError = formError?.fileLevel === true;");
    // the input and the file name key off the file-level flag, never off a bare formError
    expect(source).not.toContain("aria-invalid={formError");
    expect(source).not.toContain('formError ? "text-debt"');
    // every error still reaches the screen through the one role="alert" paragraph
    expect(source).toContain("{formError.message}");
  });

  it("clears the form error as soon as another file is picked", () => {
    const start = source.indexOf("setFile(e.target.files?.[0] ?? null);");
    expect(start).toBeGreaterThan(source.indexOf('id="imp-file"'));
    // the call sits in the file input's onChange, right after the file is stored
    expect(source.slice(start, start + 140)).toContain("setFormError(null);");
  });

  it("scrolls the error or the result into view after an import", () => {
    expect(source).toContain("fileErrorRef.current?.scrollIntoView");
    expect(source).toContain("resultRef.current?.scrollIntoView");
    expect(source).toContain("<div ref={resultRef}");
  });
});
