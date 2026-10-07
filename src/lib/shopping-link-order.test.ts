import { describe, it, expect } from "vitest";
import { orderLinkedFirst } from "@/lib/shopping-link-order";
import type { ShoppingLinkedExpense } from "@/lib/types";

const expense = (publicId: string): ShoppingLinkedExpense => ({
  publicId,
  description: publicId,
  amount: "10.00",
  date: "2026-09-01",
});

describe("orderLinkedFirst", () => {
  it("moves an already-linked expense to the front, keeping the rest in date order", () => {
    const results = [expense("a"), expense("b"), expense("c")];
    const { expenses, linkedCount } = orderLinkedFirst(results, [expense("b")]);
    expect(expenses.map((e) => e.publicId)).toEqual(["b", "a", "c"]);
    expect(linkedCount).toBe(1);
  });

  it("prepends a linked expense that fell off the fetched page", () => {
    const results = [expense("a"), expense("b")];
    const { expenses, linkedCount } = orderLinkedFirst(results, [expense("old")]);
    expect(expenses.map((e) => e.publicId)).toEqual(["old", "a", "b"]);
    expect(linkedCount).toBe(1);
  });

  it("returns the results unchanged when nothing is linked", () => {
    const results = [expense("a"), expense("b")];
    const { expenses, linkedCount } = orderLinkedFirst(results, []);
    expect(expenses.map((e) => e.publicId)).toEqual(["a", "b"]);
    expect(linkedCount).toBe(0);
  });

  it("groups every linked expense first, on-page and off-page together", () => {
    const results = [expense("a"), expense("b"), expense("c")];
    const { expenses, linkedCount } = orderLinkedFirst(results, [expense("old"), expense("c")]);
    expect(expenses.map((e) => e.publicId)).toEqual(["old", "c", "a", "b"]);
    expect(linkedCount).toBe(2);
  });
});
