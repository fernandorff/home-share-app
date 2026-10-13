import { maskAmountInput } from "@/lib/format";
import { toCents, splitCents } from "@/lib/currency";
import type { Expense, Member } from "@/lib/types";

/**
 * Pure split math for the expense form. Lives here (not inside the 'use client'
 * ExpenseFormModal) so the integer-cents/percentage logic is framework-agnostic and testable.
 */

/** Pre-fills the custom-split inputs (masked) from an existing expense's participants. */
export function participantsToMasked(
  expense: Expense | null | undefined,
  members: Member[],
  locale: string
): Record<number, string> {
  const map: Record<number, string> = {};
  if (!expense) return map;
  for (const m of members) {
    const p = expense.participants.find((x) => x.userId === m.id);
    if (p) map[m.id] = maskAmountInput(String(toCents(p.amount)), locale);
  }
  return map;
}

/** True if the stored participants exactly match an equal (largest-remainder) split. */
export function detectSplitEqually(expense: Expense, members: Member[]): boolean {
  const totalCents = toCents(expense.amount);
  const n = members.length;
  if (n === 0 || expense.participants.length !== n) return false;
  const expected = splitCents(totalCents, n);
  const actual = members.map((m) => {
    const p = expense.participants.find((x) => x.userId === m.id);
    return p ? toCents(p.amount) : -1;
  });
  return expected.every((c, i) => c === actual[i]);
}

/**
 * True if the expense's own participants split the amount equally (largest-remainder),
 * independent of the group's current member list. Unlike `detectSplitEqually`, this never
 * compares against `members.length` — a member joining the house later must not turn an
 * already-equal split among the original participants into an apparent "custom" one.
 */
export function isEqualAmongParticipants(expense: Pick<Expense, "amount" | "participants">): boolean {
  const n = expense.participants.length;
  if (n === 0) return false;
  const expected = splitCents(toCents(expense.amount), n).sort((a, b) => b - a);
  const actual = expense.participants.map((p) => toCents(p.amount)).sort((a, b) => b - a);
  return expected.every((c, i) => c === actual[i]);
}

/** Equal integer percentages summing to exactly 100. */
export function equalPercents(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(100 / n);
  const arr = Array<number>(n).fill(base);
  const rem = 100 - base * n;
  for (let i = 0; i < rem; i++) arr[i] += 1;
  return arr;
}

/**
 * Seeds a percent-mode split from an expense's REAL custom amounts (largest-remainder), so
 * switching to "by percent" without editing anything doesn't silently rewrite e.g. 70/30 as
 * 50/50. A member with no participant row on the expense (joined after it was created) seeds at 0%.
 */
export function seedPercentFromExpense(
  expense: Pick<Expense, "amount" | "participants">,
  members: Pick<Member, "id">[]
): Record<number, number> {
  const totalCents = toCents(expense.amount);
  const raw = members.map((m) => {
    const participant = expense.participants.find((p) => p.userId === m.id);
    return participant && totalCents > 0 ? (toCents(participant.amount) / totalCents) * 100 : 0;
  });
  const floors = raw.map((r) => Math.floor(r));
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => ({ frac: r - Math.floor(r), i }))
    .sort((a, b) => b.frac - a.frac)
    .forEach((o) => {
      if (remainder > 0) {
        floors[o.i]++;
        remainder--;
      }
    });
  const result: Record<number, number> = {};
  members.forEach((m, i) => (result[m.id] = floors[i]));
  return result;
}

/** Distribute totalCents by percentages with largest-remainder so it sums EXACTLY. */
export function distributeByPercent(totalCents: number, percents: number[]): number[] {
  const totalPct = percents.reduce((a, b) => a + b, 0);
  if (totalPct <= 0 || totalCents <= 0) return percents.map(() => 0);
  // Naive rounding when the percentages don't add up to 100 (submit is blocked anyway).
  if (totalPct !== 100) {
    return percents.map((p) => Math.round((totalCents * p) / 100));
  }
  const raw = percents.map((p) => (totalCents * p) / 100);
  const floors = raw.map((r) => Math.floor(r));
  const remainder = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (let k = 0; k < remainder && k < order.length; k++) out[order[k].i] += 1;
  return out;
}

/** A typed percentage (U21) as an integer 0–100 — the same domain as the slider next to it. */
export function clampPercentInput(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
