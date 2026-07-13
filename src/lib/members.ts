// Backend assigns each member a colorIndex 0–11 (round-robin). The retro-mono
// theme keeps an earthy, muted palette so members stay distinguishable without
// breaking the paper-ledger feel. Each entry pairs a fill with a readable ink.

export interface MemberStyle {
  bg: string;
  fg: string;
}

const PALETTE: MemberStyle[] = [
  { bg: "#16140f", fg: "#f2f0e9" }, // 0 ink
  { bg: "#b23a22", fg: "#f7e6e1" }, // 1 stamp red — darkened so initials meet WCAG AA
  { bg: "#2f6b4f", fg: "#eef5ef" }, // 2 pine
  { bg: "#b8801f", fg: "#1c1607" }, // 3 mustard
  { bg: "#3a5a8c", fg: "#eef2f8" }, // 4 slate blue
  { bg: "#8c3b5a", fg: "#f7e9ef" }, // 5 plum
  { bg: "#6b7036", fg: "#f3f4e6" }, // 6 olive
  { bg: "#a85a2a", fg: "#f7ece1" }, // 7 clay
  { bg: "#4a463c", fg: "#f0eee6" }, // 8 taupe
  { bg: "#2b6c70", fg: "#e6f3f3" }, // 9 teal
  { bg: "#7a4ea3", fg: "#f1e9f7" }, // 10 violet
  { bg: "#9c6b15", fg: "#f7efdf" }, // 11 amber
];

export function memberStyle(colorIndex: number): MemberStyle {
  const i = ((colorIndex % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[i];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
