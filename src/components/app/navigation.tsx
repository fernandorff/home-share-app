import { cn } from "@/components/ui/cn";

type IconProps = { className?: string };
const iconClass = "h-[18px] w-[18px]";

function ReceiptIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3v18l2-1.2L9 21l2-1.2L13 21l2-1.2L17 21l2-1.2V3l-2 1.2L15 3l-2 1.2L11 3 9 4.2 7 3 5 4.2Z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

function ScaleIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M7 21h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0Zm14 0-3 6a3 3 0 0 0 6 0Z" />
    </svg>
  );
}

function CartIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h2l2.4 12.3a1 1 0 0 0 1 .7h8.7a1 1 0 0 0 1-.8L21 8H6" />
      <circle cx="9" cy="20" r="1.3" /><circle cx="18" cy="20" r="1.3" />
    </svg>
  );
}

function GridIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function HomeIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11 12 4l8 7M6 10v9h12v-9" />
    </svg>
  );
}

function ClockIcon({ className }: IconProps) {
  return (
    <svg aria-hidden className={cn(iconClass, className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export const APP_NAVIGATION = [
  { href: "/expenses", key: "expenses", Icon: ReceiptIcon },
  { href: "/balances", key: "balances", Icon: ScaleIcon },
  { href: "/shopping", key: "shopping", Icon: CartIcon },
  { href: "/catalogs", key: "catalogs", Icon: GridIcon },
  { href: "/activity", key: "activity", Icon: ClockIcon },
  { href: "/house", key: "household", Icon: HomeIcon },
] as const;
