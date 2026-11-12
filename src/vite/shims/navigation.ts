// The router API the pages use (push/replace/back, pathname, search params), on top of react-router.
import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams as useRRSearchParams } from "react-router";

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      refresh: () => location.reload(),
      back: () => navigate(-1),
      forward: () => navigate(1),
      prefetch: () => {},
    }),
    [navigate]
  );
}
export const usePathname = () => useLocation().pathname;
export const useSearchParams = () => useRRSearchParams()[0];
export function redirect(href: string): never {
  location.replace(href);
  throw new Error("redirect");
}
