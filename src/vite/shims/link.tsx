// next/link on top of react-router (Vite variant only).
import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link as RouterLink } from "react-router";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; replace?: boolean; prefetch?: boolean; scroll?: boolean };

const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, replace, prefetch: _p, scroll: _s, ...rest }, ref) {
  return <RouterLink ref={ref} to={href} replace={replace} {...rest} />;
});
export default Link;
