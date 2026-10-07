import { cn } from "./cn";
import { memberStyle, avatarLabel } from "@/lib/members";

export function MemberDot({
  colorIndex,
  name,
  size = 24,
  className,
  glyph,
}: {
  colorIndex: number;
  name: string;
  size?: number;
  className?: string;
  /** Drawn instead of the initials (e.g. "↻" for the Automatic actor); `name` stays the accessible name. */
  glyph?: string;
}) {
  const s = memberStyle(colorIndex);
  const label = avatarLabel(name, size);
  return (
    <span
      title={name}
      aria-label={name}
      className={cn(
        // shrink-0 (U5): a fixed-size avatar inside a tight flex row (e.g. balances on a 360px
        // phone) was being squeezed into an oval "pill" instead of keeping its circle.
        "inline-flex shrink-0 items-center justify-center rounded-full font-display font-bold leading-none border border-ink/10",
        className
      )}
      style={{
        width: size,
        height: size,
        background: s.bg,
        color: s.fg,
        fontSize: label.fontSize,
      }}
    >
      {glyph ? <span aria-hidden>{glyph}</span> : label.text}
    </span>
  );
}

export function MemberChip({
  colorIndex,
  name,
  className,
}: {
  colorIndex: number;
  name: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 min-w-0", className)}>
      <MemberDot colorIndex={colorIndex} name={name} size={22} />
      {/* On mobile the who→who row is too narrow for two names; the dot carries the name
          via title/aria-label, so show the text label only from sm up. */}
      <span className="hidden truncate text-sm text-ink sm:inline">{name}</span>
    </span>
  );
}
