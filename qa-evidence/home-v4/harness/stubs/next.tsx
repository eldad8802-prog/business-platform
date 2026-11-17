// Stubs for the browser harness: next/link, next/navigation, next/dynamic, and the auth refresh coordinator.
import type { AnchorHTMLAttributes, ReactNode } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; children?: ReactNode };
export default function Link({ href, prefetch: _p, children, ...rest }: LinkProps) {
  return (
    <a href={href} data-href={href} onClick={(e) => { e.preventDefault(); (window as unknown as { __nav: string[] }).__nav.push(href); }} {...rest}>
      {children}
    </a>
  );
}

export function usePathname(): string {
  return (window as unknown as { __path: string }).__path || "/app";
}
export function useRouter() {
  return {
    push: (href: string) => (window as unknown as { __nav: string[] }).__nav.push(href),
    replace: (href: string) => (window as unknown as { __nav: string[] }).__nav.push(href),
    back: () => undefined,
    prefetch: () => undefined,
    refresh: () => undefined,
  };
}
export function useSearchParams() {
  return new URLSearchParams();
}
export function dynamic() {
  return function Nothing() {
    return null;
  };
}
export function RefreshCoordinator({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
