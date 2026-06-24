import { cn } from "./cn";
import { memberStyle, initials } from "@/lib/members";

export function MemberDot({
  colorIndex,
  name,
  size = 24,
  className,
}: {
  colorIndex: number;
  name: string;
  size?: number;
  className?: string;
}) {
  const s = memberStyle(colorIndex);
  return (
    <span
      title={name}
      aria-label={name}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-display font-bold leading-none border border-ink/10",
        className
      )}
      style={{
        width: size,
        height: size,
        background: s.bg,
        color: s.fg,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name)}
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
