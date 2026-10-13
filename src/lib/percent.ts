/**
 * Round a set of money values into whole percentages of their total that sum to exactly 100
 * (largest-remainder method), instead of rounding each row independently (`toFixed(0)` per row),
 * which can sum to 99 or 101 (D8). Works in integer cents so the rounding never depends on
 * floating-point epsilon comparisons; a value of 0 always rounds to 0.
 * Inputs must be >= 0 (callers pass expense totals, which are always positive).
 */
export function percentsTo100(values: number[]): number[] {
  const cents = values.map((v) => Math.round(v * 100));
  const total = cents.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);

  const floors = cents.map((c) => Math.floor((c * 100) / total));
  const remainders = cents.map((c, i) => c * 100 - floors[i] * total);
  const remaining = 100 - floors.reduce((a, b) => a + b, 0);

  const order = remainders
    .map((r, i) => ({ i, r }))
    .sort((a, b) => b.r - a.r || a.i - b.i);

  const result = [...floors];
  for (let k = 0; k < remaining; k++) {
    result[order[k].i] += 1;
  }
  return result;
}

/** Label for one whole-percent share (R2-29): a positive value that rounds to 0 reads "<1%" —
 *  "0%" next to a real amount looked like the month spent nothing. The numbers themselves still
 *  come from percentsTo100, so the shown integers keep summing to 100 (D8). */
export function percentLabel(percent: number, value: number): string {
  return percent === 0 && value > 0 ? '<1%' : `${percent}%`
}
