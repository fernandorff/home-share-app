import type { CSSProperties } from "react";

/**
 * Inline style for staggered entrance: pair with className="reveal".
 * Caps the delay so long lists don't wait forever.
 */
export function revealDelay(index: number, step = 40, max = 12): CSSProperties {
  return { animationDelay: `${Math.min(index, max) * step}ms` };
}
