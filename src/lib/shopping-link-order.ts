import type { ShoppingLinkedExpense } from "@/lib/types";

/**
 * Order the "Link expenses" picker rows so already-linked expenses surface first (B8 — the list
 * was sorted by date only, leaving linked rows scattered in the middle when editing an item that
 * already has links). Linked expenses that fell off the fetched page (older than the 50 most
 * recent) are prepended too, same as before. `linkedCount` tells the caller how many leading rows
 * belong to the "Linked" section.
 */
export function orderLinkedFirst(
  results: ShoppingLinkedExpense[],
  linkedExpenses: ShoppingLinkedExpense[]
): { expenses: ShoppingLinkedExpense[]; linkedCount: number } {
  const linkedIds = new Set(linkedExpenses.map((expense) => expense.publicId));
  const resultIds = new Set(results.map((expense) => expense.publicId));
  const missingLinked = linkedExpenses.filter((expense) => !resultIds.has(expense.publicId));
  const linkedInResults = results.filter((expense) => linkedIds.has(expense.publicId));
  const rest = results.filter((expense) => !linkedIds.has(expense.publicId));
  return {
    expenses: [...missingLinked, ...linkedInResults, ...rest],
    linkedCount: missingLinked.length + linkedInResults.length,
  };
}
