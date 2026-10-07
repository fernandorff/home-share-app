import { describe, it, expect } from "vitest";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, Input, Select } from "./Field";

// Field's `children` is a required prop, but createElement takes children as extra arguments
// (react/no-children-prop forbids the props object) — so the props are typed without it.
const fieldProps = (p: Omit<ComponentProps<typeof Field>, "children">) => p as ComponentProps<typeof Field>;

const field = (error?: string) =>
  renderToStaticMarkup(
    createElement(Field, fieldProps({ label: "Name", htmlFor: "f", error }), createElement(Input, { id: "f" }))
  );

describe("Field error state (U11)", () => {
  it("marks the control aria-invalid and keeps the message wired by aria-describedby", () => {
    const html = field("Required");
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    const describedBy = html.match(/<input[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}" role="alert"`);
  });

  it("leaves a valid control unmarked", () => {
    // Attribute only — the class list legitimately contains the "aria-invalid:" variant.
    expect(field()).not.toMatch(/aria-invalid="/);
  });

  it("styles the invalid state with the debt border", () => {
    expect(field("x")).toMatch(/<input[^>]*class="[^"]*aria-invalid:border-debt/);
  });

  it("reaches the native <select> through Select", () => {
    const html = renderToStaticMarkup(
      createElement(
        Field,
        fieldProps({ label: "To", htmlFor: "s", error: "Same person" }),
        createElement(Select, { id: "s" }, createElement("option", { value: "" }, "—"))
      )
    );
    expect(html).toMatch(/<select[^>]*aria-invalid="true"/);
  });
});
